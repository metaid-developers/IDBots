/**
 * Feishu Media Upload Utilities
 * 飞书媒体上传工具函数
 */
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

// Types
export type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

export interface FeishuImageUploadResult {
  success: boolean;
  imageKey?: string;
  error?: string;
}

export interface FeishuFileUploadResult {
  success: boolean;
  fileKey?: string;
  error?: string;
}

// Constants
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.tiff'];
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB for Feishu

/**
 * Upload image to Feishu
 * @param client - Feishu REST client
 * @param image - Buffer or file path
 * @param imageType - 'message' for chat images, 'avatar' for profile pictures
 */
export async function uploadImageToFeishu(
  client: any,
  image: Buffer | string,
  imageType: 'message' | 'avatar' = 'message'
): Promise<FeishuImageUploadResult> {
  try {
    // Validate file size if path provided
    if (typeof image === 'string') {
      const stats = fs.statSync(image);
      if (stats.size > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `Image too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (limit 30MB)`
        };
      }
    } else if (image.length > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `Image too large: ${(image.length / 1024 / 1024).toFixed(1)}MB (limit 30MB)`
      };
    }

    // SDK expects a Readable stream
    const imageStream = typeof image === 'string'
      ? fs.createReadStream(image)
      : Readable.from(image);

    const response = await client.im.image.create({
      data: {
        image_type: imageType,
        image: imageStream as any,
      },
    });

    const responseAny = response as any;
    if (responseAny.code !== undefined && responseAny.code !== 0) {
      return {
        success: false,
        error: `Feishu error: ${responseAny.msg || `code ${responseAny.code}`}`
      };
    }

    // SDK v1.30+ may return data in different formats
    const imageKey = responseAny.image_key ?? responseAny.data?.image_key;
    if (!imageKey) {
      return { success: false, error: 'No image_key returned' };
    }

    return { success: true, imageKey };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Upload file to Feishu
 * @param client - Feishu REST client
 * @param file - Buffer or file path
 * @param fileName - Name of the file
 * @param fileType - Feishu file type
 * @param duration - Duration in milliseconds (for audio/video)
 */
export async function uploadFileToFeishu(
  client: any,
  file: Buffer | string,
  fileName: string,
  fileType: FeishuFileType,
  duration?: number
): Promise<FeishuFileUploadResult> {
  try {
    // Validate file size
    if (typeof file === 'string') {
      const stats = fs.statSync(file);
      if (stats.size > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (limit 30MB)`
        };
      }
    } else if (file.length > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `Buffer too large: ${(file.length / 1024 / 1024).toFixed(1)}MB (limit 30MB)`
      };
    }

    // SDK expects a Readable stream
    const fileStream = typeof file === 'string'
      ? fs.createReadStream(file)
      : Readable.from(file);

    const response = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fileStream as any,
        ...(duration !== undefined && { duration }),
      },
    });

    const responseAny = response as any;
    if (responseAny.code !== undefined && responseAny.code !== 0) {
      return {
        success: false,
        error: `Feishu error: ${responseAny.msg || `code ${responseAny.code}`}`
      };
    }

    const fileKey = responseAny.file_key ?? responseAny.data?.file_key;
    if (!fileKey) {
      return { success: false, error: 'No file_key returned' };
    }

    return { success: true, fileKey };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Detect Feishu file type from file extension
 */
export function detectFeishuFileType(fileName: string): FeishuFileType {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.opus':
    case '.ogg':
      return 'opus';
    case '.mp4':
    case '.mov':
    case '.avi':
      return 'mp4';
    case '.pdf':
      return 'pdf';
    case '.doc':
    case '.docx':
      return 'doc';
    case '.xls':
    case '.xlsx':
      return 'xls';
    case '.ppt':
    case '.pptx':
      return 'ppt';
    default:
      return 'stream';
  }
}

/**
 * Check if file path points to an image
 */
export function isFeishuImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if file path points to an audio file
 */
export function isFeishuAudioPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.opus', '.ogg', '.mp3', '.wav', '.m4a', '.aac', '.amr'].includes(ext);
}

/**
 * Resolve file path (handle file:// protocol and ~ home directory)
 */
export function resolveFeishuMediaPath(rawPath: string): string {
  let resolved = rawPath;

  // Handle file:// protocol
  if (resolved.startsWith('file:///')) {
    resolved = decodeURIComponent(resolved.replace('file://', ''));
  }

  // Handle ~ home directory
  if (resolved.startsWith('~')) {
    resolved = resolved.replace('~', process.env.HOME || '');
  }

  return resolved;
}
