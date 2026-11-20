'use strict';

const { db } = require('../config/firebase');

const SUCCESSFUL_DEPOSIT_REQUIRED_MESSAGE =
  'Fitur ini tersedia setelah minimal satu deposit berapa pun berhasil dibayar.';

async function hasSuccessfulDeposit(uid) {
  const depositsSnap = await db.ref('deposits')
    .orderByChild('user_id')
    .equalTo(uid)
    .once('value');

  return Object.values(depositsSnap.val() || {})
    .some(deposit => deposit && deposit.status === 'SUCCESS');
}

module.exports = {
  SUCCESSFUL_DEPOSIT_REQUIRED_MESSAGE,
  hasSuccessfulDeposit,
};
