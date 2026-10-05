import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function createR2Storage(s3Client, bucketName){
    return {
        async getURL(key){
            const command = new GetObjectCommand({Bucket: bucketName, Key: key});
            const url = await getSignedUrl(s3Client, command, {expiresIn: 3600});
            return url
        }
    }
}