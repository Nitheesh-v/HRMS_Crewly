import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import env from './config/env.js';
import requestLogger from './middlewares/requestLogger.js';
import notFound from './middlewares/notFound.js';
import errorHandler from './middlewares/errorHandler.js';
import routes from './routes/index.js';

const app = express();

// ---- Security & parsing ----
app.use(helmet());
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ---- HTTP request logging (morgan -> winston) ----
app.use(requestLogger);



// ---- API routes (all under /api) ----
app.use('/api', routes);

// ---- 404 + global error handler (must be last) ----
app.use(notFound);
app.use(errorHandler);

export default app;
