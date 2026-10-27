import { isStaff } from './permissions.js';
import { listOrders } from './order-data.js';
import { calculateBoxRequirements } from './box-req-calc.js';
export { BOX_UNITS } from './box-req-calc.js';

export async function listBoxRequirements(db, profile) {
  if (!isStaff(profile)) throw new Error('Admin or Account Admin access is required.');
  return calculateBoxRequirements(await listOrders(db));
}
