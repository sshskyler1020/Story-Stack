/**
 * AWS S3 client (SDK v3) — used both by the multer-s3 upload middleware
 * and by the presigned-URL generator for the secure reader route.
 */
const { S3Client } = require('@aws-sdk/client-s3');
const config = require('./config');

const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

const BUCKET_NAME = config.aws.bucketName;

module.exports = { s3Client, BUCKET_NAME };
