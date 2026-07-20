const axios = require('axios');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

function paystackRequest(method, path, data) {
  return axios({
    method,
    url: `https://api.paystack.co${path}`,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    data,
  });
}

async function createCustomer({ email, firstName, lastName, phone }) {
  const response = await paystackRequest('POST', '/customer', {
    email,
    first_name: firstName,
    last_name: lastName,
    phone,
  });
  return response.data.data;
}

async function createDedicatedAccount({ customerCode }) {
  const response = await paystackRequest('POST', '/dedicated_account', {
    customer: customerCode,
    preferred_bank: 'wema-bank', // or 'first-bank', 'gtbank', etc.
  });
  return response.data.data;
}

async function getTransaction({ reference }) {
  const response = await paystackRequest('GET', `/transaction/${reference}`);
  return response.data.data;
}

module.exports = { createCustomer, createDedicatedAccount, getTransaction };