import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

const bucket = process.env.S3_BUCKET || 'agent-qa-uploads';
let client;
let bucketReady;
function getClient() {
  if (!client) client = new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || 'http://127.0.0.1:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || 'agentqa', secretAccessKey: process.env.S3_SECRET_KEY || 'agentqa-local-secret' },
  });
  return client;
}
async function ensureBucket() {
  if (!bucketReady) bucketReady = (async () => {
    try { await getClient().send(new HeadBucketCommand({ Bucket: bucket })); }
    catch { await getClient().send(new CreateBucketCommand({ Bucket: bucket })); }
  })().catch(error => { bucketReady = null; throw error; });
  await bucketReady;
}
export async function storeUpload(filename, body, contentType = 'application/octet-stream', stableKey = null) {
  await ensureBucket();
  const key = stableKey || `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${filename.replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
  await getClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return key;
}
export async function deleteUpload(key) {
  if (!key) return;
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
export async function readUpload(key) {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}
