// Este archivo manejaría la lógica para sincronizar datos de Kraken
require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const apiKey = process.env.API_KEY;
const apiSecret = process.env.API_SECRET;

const apiRoot = 'https://api.kraken.com';
const apiVersion = '/0';

function getKrakenSignature(urlpath, request, secret) {
    const message = request.nonce + request.body;
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

async function getServerTime() {
    const endpoint = '/public/Time';
    try {
        const response = await axios.get(`${apiRoot}${apiVersion}${endpoint}`);
        console.log('Hora del servidor:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error al obtener la hora del servidor:', error);
    }
}

async function getBalance() {
    const endpoint = '/private/Balance';
    const nonce = new Date() * 1000;
    const postData = `nonce=${nonce}`;
    const signature = getKrakenSignature(apiVersion + endpoint, { nonce: nonce, body: postData }, apiSecret);
    const headers = buildHeaders(apiKey, signature);

    try {
        const response = await axios.post(`${apiRoot}${apiVersion}${endpoint}`, postData, { headers });
        console.log('Balance de la cuenta:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error al obtener el balance:', error);
    }
}

module.exports = {
    getServerTime,
    getBalance
};