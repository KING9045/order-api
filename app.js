const express = require('express');
const fs = require('fs');
const axios = require('axios'); // Re-import axios for making HTTP requests
const { jsPDF } = require('jspdf');
require('jspdf-autotable');
const qrcode = require('qrcode');
const NodeCache = require('node-cache');
const stream = require('stream');
const { promisify } = require('util');

const app = express();
const port = 3000;
const pipeline = promisify(stream.pipeline);

// Create a cache with a TTL of 5 minutes
const cache = new NodeCache({ stdTTL: 300 });

app.use(express.json());

// POST route to accept id, time, and url in the JSON body
app.post('/generate-table-pdf', async (req, res) => {
    try {
        const { id, time, url } = req.body;

        if (!id || !time || !url) {
            return res.status(400).json({ error: 'Please provide "id", "time", and "url" in the request body' });
        }

        // Construct the full API endpoint using the provided id and time
        const apiUrl = `${url}/${id}?time=${encodeURIComponent(time)}`;

        // Check cache first using the complete API URL as the key
        const cachedPdf = cache.get(apiUrl);
        if (cachedPdf) {
            res.contentType('application/pdf');
            return res.send(cachedPdf);
        }

        // Fetch JSON data from the dynamically constructed URL
        const response = await axios.get(apiUrl, { responseType: 'stream' });
        const data = await streamToJson(response.data);

        // Ensure the data is an object (not an array)
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            return res.status(400).json({ error: 'The JSON data from the API must be an object with key-value pairs' });
        }

        // Generate the PDF with receipt size and additional elements
        const doc = await createReceiptPdf(id, time, data);

        // Output the PDF as a buffer
        const pdfBuffer = doc.output('arraybuffer');

        // Cache the PDF
        cache.set(apiUrl, pdfBuffer);

        // Send the PDF as response
        res.contentType('application/pdf');
        const readStream = new stream.PassThrough();
        readStream.end(Buffer.from(pdfBuffer));
        await pipeline(readStream, res);

    } catch (error) {
        console.error(error);
        handleError(res, error);
    }
});

async function streamToJson(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Function to create a receipt-sized PDF with Order ID, Time, and a logo from root directory
async function createReceiptPdf(orderId, time, data) {
    // Dynamically calculate the height based on the number of items
    const baseHeight = 100; // Base height for non-table content
    const itemsCount = Object.keys(data).filter(key => key !== 'id' && key !== 'time').length;
    const dynamicHeight = baseHeight + (itemsCount * 10) + 50; // Adjust the height dynamically

    const doc = new jsPDF({
        unit: 'mm',
        format: [80, dynamicHeight], // Custom receipt size with dynamic height
    });

    // Load the logo from the root directory
    const logoPath = './logo.png';
    if (fs.existsSync(logoPath)) {
        const logo = fs.readFileSync(logoPath, { encoding: 'base64' }); // Read the logo as base64
        doc.addImage(logo, 'PNG', 25, 10, 30, 30); // Centered logo (x=25, y=10)
    } else {
        console.error('Logo file not found');
    }

    // Display Order ID and Time below the logo
    doc.setFontSize(12);
    doc.text(`Order ID: ${orderId}`, 10, 45);
    doc.text(`Time: ${time}`, 10, 50);

    // Prepare table data excluding 'id' and 'time'
    const tableData = Object.keys(data)
        .filter(key => key !== 'id' && key !== 'time')
        .map(key => [key, data[key]]);

    // Generate table with two columns: Item Name and Quantity (restore to the original size)
    doc.autoTable({
        head: [['Item Name', 'Quantity']],
        body: tableData,
        startY: 60, // Start table after the Order ID and Time
        styles: { fontSize: 10, cellPadding: 3 }, // Restored table size (smaller than the previous larger table)
    });

    // Calculate the height of the content to know where to place the QR code
    const finalY = doc.lastAutoTable.finalY || 60;

    // Add a QR code with order details at the bottom
    const qrContent = `Order ID: ${orderId}, Time: ${time}, Items: ${JSON.stringify(data)}`;
    const qrCodeImage = await qrcode.toDataURL(qrContent);
    doc.addImage(qrCodeImage, 'PNG', 20, finalY + 10, 40, 40); // Larger QR code (40x40mm)

    return doc;
}

function handleError(res, error) {
    if (error.response) {
        res.status(error.response.status).json({ error: `Error from API: ${error.response.data}` });
    } else if (error.request) {
        res.status(503).json({ error: 'Unable to reach the specified API' });
    } else {
        res.status(500).json({ error: 'An error occurred while processing your request' });
    }
}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
