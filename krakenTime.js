require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const apiKey = process.env.API_KEY;
const apiSecret = process.env.API_SECRET;

const apiRoot = 'https://api.kraken.com';
const apiVersion = '/0';
const endpoint = '/public/Time'; // Endpoint para obtener el tiempo del servidor

function getKrakenSignature(urlpath, request, secret, nonce) {
    const message = nonce + request.body;
    const secret_buffer = Buffer.from(secret, 'base64');
    const hash_digest = crypto.createHash('sha256').update(message).digest();
    const hmac = crypto.createHmac('sha512', secret_buffer).update(urlpath + hash_digest).digest('base64');

    return hmac;
}

function buildHeaders(apiKey, apiSign) {
    return {
        'API-Key': apiKey,
        'API-Sign': apiSign
    };
}

const nonce = new Date() * 1000; // nonce como milisegundos desde la época UNIX
const postData = `nonce=${nonce}`;

const signature = getKrakenSignature(apiVersion + endpoint, { nonce: nonce, body: postData }, apiSecret);
const headers = buildHeaders(apiKey, signature);

// Realizar la petición POST a la API de Kraken
axios.post(`${apiRoot}${apiVersion}${endpoint}`, postData, { headers })
    .then(response => {
        console.log('Respuesta de la API de Kraken:', response.data);  // Mostrar los datos obtenidos
    })
    .catch(error => {
        console.error('Error al hacer la petición a Kraken:', error);  // Manejar errores
    });