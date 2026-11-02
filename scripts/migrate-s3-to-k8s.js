import '../src/env.js';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const bucket = process.env.S3_BUCKET || 'agent-qa-uploads';
const accessKeyId = process.env.S3_ACCESS_KEY || 'agentqa';
const secretAccessKey = process.env.S3_SECRET_KEY || 'change-this-object-storage-password';
const region = process.env.S3_REGION || 'us-east-1';
const makeClient = endpoint => new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
const source = makeClient(process.env.MIGRATE_S3_SOURCE || 'http://127.0.0.1:8333');
const target = makeClient(process.env.MIGRATE_S3_TARGET || 'http://127.0.0.1:18333');

try {
  try { await target.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch { await target.send(new CreateBucketCommand({ Bucket: bucket })); }
  let continuationToken, copied = 0;
  do {
    const page = await source.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const object of page.Contents || []) {
      if (!object.Key) continue;
      const result = await source.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      await target.send(new PutObjectCommand({
        Bucket: bucket,
        Key: object.Key,
        Body: result.Body,
        ContentLength: result.ContentLength ?? object.Size,
        ContentType: result.ContentType,
        Metadata: result.Metadata,
      }));
      copied++;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  process.stdout.write(`Copied ${copied} object(s) into the Kubernetes SeaweedFS bucket.\n`);
} finally {
  source.destroy();
  target.destroy();
}
