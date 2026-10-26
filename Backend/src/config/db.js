import dns from 'node:dns';
import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';
import { diagnoseMongoFailure, parseDnsServers } from './mongoDiagnostics.js';

// A `mongodb+srv://` URI is resolved by the driver *in this process*, so the
// resolver Node uses is the one that decides whether Atlas is reachable. On
// some Windows setups (VPN, WARP, antivirus DNS filters, ISP resolvers that
// drop SRV queries) that lookup is refused while the cluster itself is fine.
// Setting MONGO_DNS_SERVERS in Backend/.env points only this process at a
// resolver that answers; it changes nothing for the rest of the machine.
const dnsServers = parseDnsServers(process.env.MONGO_DNS_SERVERS);

if (dnsServers.length) {
  try {
    dns.setServers(dnsServers);
    logger.info(`🌐 MongoDB DNS: using ${dnsServers.join(', ')} (MONGO_DNS_SERVERS)`);
  } catch (error) {
    logger.warn(`⚠️  MONGO_DNS_SERVERS ignored: ${error.message}`);
  }
}

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', true);

    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });

    logger.info(`✅ MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    const verdict = diagnoseMongoFailure(error, env.MONGO_URI);

    // The driver's one-liner names the symptom; the steps name the fix. Never
    // print the URI — it carries the password.
    logger.error(`❌ MongoDB connection failed: ${error.message}`);
    logger.error(`   cause: ${verdict.summary}`);
    verdict.steps.forEach((step, i) => logger.error(`   ${i + 1}. ${step}`));

    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  logger.warn('⚠️  MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error(`MongoDB error: ${err.message}`);
});

export default connectDB;
