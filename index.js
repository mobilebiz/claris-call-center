import { Vonage } from "@vonage/server-sdk";
import { vcr } from "@vonage/vcr-sdk";
import express from 'express';

const app = express();
const port = process.env.VCR_PORT;

const vonage = new Vonage(
    {
        applicationId: process.env.API_APPLICATION_ID,
        privateKey: process.env.PRIVATE_KEY
    }
);

app.use(express.json());
app.use(express.static('public'));

app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`)
});