import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const redisOptions = () => ({
  maxRetriesPerRequest: null,
  retryStrategy: retries => Math.min(retries * 250, 5_000),
});
export function createRedisConnection() {
  return process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, redisOptions())
    : new IORedis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD || undefined, ...redisOptions() });
}
export function createQueues(connection = createRedisConnection()) {
  return {
    connection,
    chat: new Queue('agent-qa-chat', { connection, defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 1500 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 5000 } } }),
    documents: new Queue('agent-qa-documents', { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: { age: 86400, count: 5000 }, removeOnFail: { age: 604800, count: 5000 } } }),
  };
}
export const chatChannel = jobId => `agent-qa:chat:${jobId}`;
export async function publishEvent(connection, jobId, event, data) {
  await connection.publish(chatChannel(jobId), JSON.stringify({ event, data }));
}

const acquireScript = `
  local key=KEYS[1]; local token=ARGV[1]; local now=tonumber(ARGV[2]); local expiry=tonumber(ARGV[3]); local cap=tonumber(ARGV[4]);
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now);
  if redis.call('ZCARD', key) < cap then redis.call('ZADD', key, expiry, token); redis.call('PEXPIRE', key, expiry-now); return 1 end;
  return 0`;
export async function acquireModelSlot(connection, jobId, signal) {
  const key = 'agent-qa:model-slots'; const token = `${jobId}:${Math.random().toString(36).slice(2)}`;
  const capacity = Math.max(1, Number(process.env.MODEL_CONCURRENCY || 8)); const leaseMs = 120_000;
  while (!signal?.aborted) {
    const now = Date.now();
    if (await connection.eval(acquireScript, 1, key, token, now, now + leaseMs, capacity)) {
      const heartbeat = setInterval(() => connection.multi().zadd(key, Date.now() + leaseMs, token).pexpire(key, leaseMs).exec().catch(() => {}), leaseMs / 3);
      return async () => { clearInterval(heartbeat); await connection.zrem(key, token); };
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 400);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('任务已取消。')); }, { once: true });
    });
  }
  throw signal?.reason || new Error('任务已取消。');
}
