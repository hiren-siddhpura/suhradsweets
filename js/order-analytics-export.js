import { analyticsColumns, matchingOrders, quantities, totalText } from './order-analytics-data.js';

export const userExcelFilename = (name) => {
  const stem = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/\s+/g, '_').replace(/[. ]+$/g, '');
  return `${stem || 'user_orders'}.xlsx`;
};

export function userOrderWorkbook(data, filters, uid, statusLabel) {
  const user = data.users.find((entry) => entry.id === uid);
  if (!user || !data.staff && uid !== data.viewerUid) throw new Error('You cannot export this user’s orders.');
  const columns = analyticsColumns(data);
  const orders = matchingOrders(data, filters).filter((order) => order.assignedUserId === uid);
  const headers = ['User Name', 'Customer Name', 'Customer Phone', 'Customer Area', 'Order Number', 'Order Date', 'Order Status',
    ...columns.map((col) => `${col.name} (${col.unit})`), 'Total Quantity', 'Order Amount'];
  const totals = quantities(orders, columns);
  const rows = orders.map((order) => {
    const customer = data.customers.find((entry) => entry.id === order.customerId);
    const values = quantities([order], columns);
    return [user.name, customer?.name || order.customerName || '', customer?.phone || '', customer?.area || '',
      order.orderNumber || '', order.orderDate || '', statusLabel(order), ...columns.map((col) => values[col.key]),
      totalText(values, columns), Number.isSafeInteger(order.grandTotalPaise) ? order.grandTotalPaise / 100 : ''];
  });
  rows.push(['TOTAL', '', '', '', '', '', '', ...columns.map((col) => totals[col.key]), totalText(totals, columns),
    orders.every((order) => Number.isSafeInteger(order.grandTotalPaise)) ? orders.reduce((sum, order) => sum + order.grandTotalPaise, 0) / 100 : '']);
  return { filename: userExcelFilename(user.name), headers, rows, orderCount: orders.length, quantityStart: 7 };
}
