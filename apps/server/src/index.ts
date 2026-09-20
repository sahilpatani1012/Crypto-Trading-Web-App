/**
 * Server entry point.
 *
 * S0 scaffold: proves the workspace resolves and the process boots. The market
 * engine lands in S1 and the REST + WebSocket transport in S2.
 */

import { SYMBOL, INTERVAL_IDS, PRICE_SCALE, QTY_SCALE } from '@cta/protocol';
import { serverConfig } from './config';

console.log('[boot] @cta/server');
console.log('[boot] symbol=%s intervals=%s', SYMBOL, INTERVAL_IDS.join(','));
console.log('[boot] priceScale=%d qtyScale=%d seed=%d', PRICE_SCALE, QTY_SCALE, serverConfig.seed);
console.log('[boot] listening target %s:%d', serverConfig.host, serverConfig.port);
