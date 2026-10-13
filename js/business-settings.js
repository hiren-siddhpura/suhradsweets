export const BUSINESS_DETAILS_ID = 'business_details';

export function validateBusinessDetails(input = {}) {
  const address = String(input.address ?? '').trim();
  const contactNumber = String(input.contactNumber ?? '').trim();
  const fssaiLicenseNo = String(input.fssaiLicenseNo ?? '').trim();
  if (address.length > 300 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(address)) throw new Error('Business address must be 300 characters or fewer.');
  if (contactNumber.length > 80 || /[\x00-\x1F]/.test(contactNumber)) throw new Error('Business contact must be 80 characters or fewer.');
  if (fssaiLicenseNo.length > 40 || !/^[A-Za-z0-9 /-]*$/.test(fssaiLicenseNo)) throw new Error('Enter a valid FSSAI License No. (up to 40 letters, digits, spaces, / or -).');
  return { address, contactNumber, fssaiLicenseNo };
}
