import axios from 'axios';
import prisma from './prisma.js';
import logger from './logger.js';

const UPSTOX_BASE_URL = 'https://api.upstox.com/v2';

/**
 * Get Upstox integration for a user
 */
async function getIntegration(userId) {
  const integration = await prisma.upstoxIntegration.findUnique({
    where: { userId }
  });

  if (!integration || !integration.isConnected || !integration.accessToken) {
    throw new Error('Upstox not connected. Please link your Upstox account first.');
  }

  // Check token expiry
  if (integration.tokenExpiresAt && new Date() > new Date(integration.tokenExpiresAt)) {
    throw new Error('Upstox token expired. Please re-authenticate.');
  }

  return integration;
}

/**
 * Make authenticated request to Upstox API
 */
async function upstoxRequest(accessToken, method, endpoint, data = null) {
  const config = {
    method,
    url: `${UPSTOX_BASE_URL}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };

  if (data && (method === 'POST' || method === 'PUT')) {
    config.data = data;
  }

  const response = await axios(config);
  return response.data;
}

/**
 * Place an order via Upstox
 */
export async function placeOrder(userId, orderParams) {
  const integration = await getIntegration(userId);

  const {
    symbol,
    exchange = 'NSE_EQ',
    transactionType, // BUY or SELL
    orderType = 'MARKET', // MARKET, LIMIT
    quantity,
    price = 0,
    triggerPrice = 0,
    portfolioId = null
  } = orderParams;

  // Construct instrument key (Upstox format)
  const instrumentKey = `${exchange}|${symbol}`;

  const orderData = {
    quantity,
    product: 'D', // Delivery
    validity: 'DAY',
    price: orderType === 'LIMIT' ? price : 0,
    tag: `invest-copilot-${Date.now()}`,
    instrument_token: instrumentKey,
    order_type: orderType,
    transaction_type: transactionType,
    disclosed_quantity: 0,
    trigger_price: triggerPrice,
    is_amo: false
  };

  logger.info(`Placing Upstox order: ${transactionType} ${quantity}x ${symbol}`, orderData);

  const result = await upstoxRequest(
    integration.accessToken,
    'POST',
    '/order/place',
    orderData
  );

  // Record order in DB
  const order = await prisma.upstoxOrder.create({
    data: {
      integrationId: integration.id,
      portfolioId,
      orderId: result.data?.order_id || `manual-${Date.now()}`,
      symbol,
      exchange,
      transactionType,
      orderType,
      quantity,
      price: price || null,
      triggerPrice: triggerPrice || null,
      status: 'PENDING',
      placedAt: new Date()
    }
  });

  logger.info(`Upstox order placed: ${order.orderId}`);

  return {
    success: true,
    orderId: order.orderId,
    dbOrderId: order.id,
    upstoxResponse: result.data
  };
}

/**
 * Get order status from Upstox
 */
export async function getOrderStatus(userId, orderId) {
  const integration = await getIntegration(userId);

  const result = await upstoxRequest(
    integration.accessToken,
    'GET',
    `/order/details?order_id=${orderId}`
  );

  const orderData = result.data;

  // Update local DB
  if (orderData) {
    await prisma.upstoxOrder.updateMany({
      where: { orderId },
      data: {
        status: orderData.status || 'PENDING',
        filledQuantity: orderData.filled_quantity || 0,
        averagePrice: orderData.average_price || null,
        message: orderData.status_message || null,
        executedAt: orderData.status === 'COMPLETE' ? new Date() : null
      }
    });
  }

  return {
    orderId,
    status: orderData?.status || 'UNKNOWN',
    filledQuantity: orderData?.filled_quantity || 0,
    averagePrice: orderData?.average_price || null,
    message: orderData?.status_message || null
  };
}

/**
 * Cancel an order
 */
export async function cancelOrder(userId, orderId) {
  const integration = await getIntegration(userId);

  const result = await upstoxRequest(
    integration.accessToken,
    'DELETE',
    `/order/cancel?order_id=${orderId}`
  );

  // Update local DB
  await prisma.upstoxOrder.updateMany({
    where: { orderId },
    data: { status: 'CANCELLED' }
  });

  logger.info(`Upstox order cancelled: ${orderId}`);

  return {
    success: true,
    orderId,
    upstoxResponse: result.data
  };
}

/**
 * Get live holdings from Upstox
 */
export async function getHoldings(userId) {
  const integration = await getIntegration(userId);

  const result = await upstoxRequest(
    integration.accessToken,
    'GET',
    '/portfolio/long-term-holdings'
  );

  // Update last sync time
  await prisma.upstoxIntegration.update({
    where: { id: integration.id },
    data: { lastSyncAt: new Date() }
  });

  return {
    holdings: result.data || [],
    syncedAt: new Date().toISOString()
  };
}
