// /services/s3Service.js - Dịch vụ tải lên AWS S3

const { PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const s3 = require("../config/s3");

const uploadToS3 = async (file) => {
  if (!file || !file.path) {
    throw new Error("File không tồn tại");
  }

  const fileStream = fs.createReadStream(file.path);

  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: file.filename,
    Body: fileStream,
    ContentType: file.mimetype,
  };

  await s3.send(new PutObjectCommand(params));

  fs.unlinkSync(file.path);

  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${file.filename}`;
};

module.exports = { uploadToS3 };