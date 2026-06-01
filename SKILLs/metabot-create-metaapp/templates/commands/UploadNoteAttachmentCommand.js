import PostBuzzCommand from './PostBuzzCommand.js';

export default class UploadNoteAttachmentCommand {
  constructor(options = {}) {
    this._uploadHost = options && options.uploadHost ? options.uploadHost : new PostBuzzCommand();
    this._uploader = options && options.uploader
      ? options.uploader
      : (this._uploadHost && this._uploadHost._uploader ? this._uploadHost._uploader : null);
  }

  async execute({ payload = {}, stores }) {
    var file = payload && payload.file;
    var options = payload && payload.options && typeof payload.options === 'object'
      ? payload.options
      : {};
    if (!this._uploader || typeof this._uploader.uploadFileToMetafile !== 'function') {
      throw new Error('Upload helper is not available');
    }
    return await this._uploader.uploadFileToMetafile(file, stores, options);
  }
}
