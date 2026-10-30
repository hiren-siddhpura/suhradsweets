export function validateAttachmentFile(file) {
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' })[file?.type];
  if (!extension || !new RegExp(`\\.${extension === 'jpg' ? 'jpe?g' : extension}$`, 'i').test(file.name)) throw new Error('Choose a JPG, JPEG, PNG or PDF attachment.');
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error('The attachment is empty. Choose another file.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Attachment exceeds 5 MB. Choose a smaller file.');
  return extension;
}
