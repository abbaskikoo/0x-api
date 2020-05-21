import bodyParser = require('body-parser');
import * as cors from 'cors';
import * as express from 'express';
// tslint:disable-next-line:no-implicit-dependencies
import * as core from 'express-serve-static-core';
import { Server } from 'http';

import { AppDependencies, getDefaultAppDependenciesAsync } from '../app';
import * as defaultConfig from '../config';
import { META_TRANSACTION_PATH, METRICS_PATH, SRA_PATH, STAKING_PATH, SWAP_PATH } from '../constants';
import { rootHandler } from '../handlers/root_handler';
import { logger } from '../logger';
import { addressNormalizer } from '../middleware/address_normalizer';
import { errorHandler } from '../middleware/error_handling';
import { requestLogger } from '../middleware/request_logger';
import { createMetaTransactionRouter } from '../routers/meta_transaction_router';
import { createMetricsRouter } from '../routers/metrics_router';
import { createSRARouter } from '../routers/sra_router';
import { createStakingRouter } from '../routers/staking_router';
import { createSwapRouter } from '../routers/swap_router';
import { WebsocketService } from '../services/websocket_service';
import { providerUtils } from '../utils/provider_utils';

/**
 * http_service_runner hosts endpoints for staking, sra, swap and meta-txns (minus the /submit endpoint)
 * and can be horizontally scaled as needed
 */

process.on('uncaughtException', err => {
    logger.error(err);
    process.exit(1);
});

process.on('unhandledRejection', err => {
    if (err) {
        logger.error(err);
    }
});

if (require.main === module) {
    (async () => {
        const provider = providerUtils.createWeb3Provider(defaultConfig.ETHEREUM_RPC_URL);
        const dependencies = await getDefaultAppDependenciesAsync(provider, defaultConfig);
        await runHttpServiceAsync(dependencies, defaultConfig);
    })().catch(error => logger.error(error.stack));
}

export interface HttpServices {
    server: Server;
    wsService: WebsocketService;
}

/**
 * This service handles the HTTP requests. This involves fetching from the database
 * as well as adding orders to mesh.
 * @param dependencies If no mesh client is supplied, the HTTP service will start without it.
 *                     It will provide defaults for other params.
 */
export async function runHttpServiceAsync(
    dependencies: AppDependencies,
    config: {
        HTTP_PORT: number;
        HTTP_KEEP_ALIVE_TIMEOUT: number;
        HTTP_HEADERS_TIMEOUT: number;
        PROMETHEUS_PORT: number;
        META_TXN_RATE_LIMIT_TYPE?: string;
    },
    _app?: core.Express,
): Promise<HttpServices> {
    const app = _app || express();
    app.use(requestLogger());
    app.use(cors());
    app.use(bodyParser.json());

    app.get('/', rootHandler);
    const server = app.listen(config.HTTP_PORT, () => {
        logger.info(`API (HTTP) listening on port ${config.HTTP_PORT}!`);
    });
    server.on('error', err => {
        logger.error(err);
    });
    server.keepAliveTimeout = config.HTTP_KEEP_ALIVE_TIMEOUT;
    server.headersTimeout = config.HTTP_HEADERS_TIMEOUT;

    // transform all values of `req.query.[xx]Address` to lowercase
    app.use(addressNormalizer);

    // staking http service
    app.use(STAKING_PATH, createStakingRouter(dependencies.stakingDataService));

    // SRA http service
    app.use(SRA_PATH, createSRARouter(dependencies.orderBookService));

    // Meta transaction http service
    if (dependencies.metaTransactionService) {
        app.use(META_TRANSACTION_PATH, createMetaTransactionRouter(dependencies.metaTransactionService));
    } else {
        logger.error(`API running without meta transactions service`);
    }

    // swap/quote http service
    if (dependencies.swapService) {
        app.use(SWAP_PATH, createSwapRouter(dependencies.swapService));
    } else {
        logger.error(`API running without swap service`);
    }
    if (dependencies.metricsService) {
        const metricsRouter = createMetricsRouter(dependencies.metricsService);
        if (config.PROMETHEUS_PORT === config.HTTP_PORT) {
            // if the target prometheus port is the same as the base app port,
            // we just add the router to latter.
            app.use(METRICS_PATH, metricsRouter);
        } else {
            // otherwise we create a separate server for metrics.
            const metricsApp = express();
            metricsApp.use(METRICS_PATH, metricsRouter);
            const metricsServer = metricsApp.listen(config.PROMETHEUS_PORT, () => {
                logger.info(`Metrics (HTTP) listening on port ${defaultConfig.PROMETHEUS_PORT}`);
            });
            metricsServer.on('error', err => {
                logger.error(err);
            });
        }
    }

    app.use(errorHandler);

    // websocket service
    let wsService: WebsocketService;
    if (dependencies.meshClient) {
        // tslint:disable-next-line:no-unused-expression
        wsService = new WebsocketService(server, dependencies.meshClient, dependencies.websocketOpts);
    } else {
        logger.error(`Could not establish mesh connection, exiting`);
        process.exit(1);
    }

    return {
        server,
        wsService,
    };
}
