import { memoryStorage } from 'multer';
import { StorageEngine } from 'multer';

/** In-memory multer storage factory for small file uploads (e.g. .jzapp packages) */
export function memStorage(): StorageEngine {
  return memoryStorage();
}
