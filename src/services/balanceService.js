'use strict';

function getBalanceBuckets(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('User balance record is invalid.');
  }

  const balance = Number(user.balance || 0);
  const withdrawableBalance = user.withdrawable_balance === undefined || user.withdrawable_balance === null
    ? balance
    : Number(user.withdrawable_balance);
  if (!Number.isSafeInteger(balance) || balance < 0 ||
      !Number.isSafeInteger(withdrawableBalance) || withdrawableBalance < 0 ||
      withdrawableBalance > balance) {
    throw new Error('User balance buckets are invalid.');
  }

  return {
    balance,
    withdrawableBalance,
    bonusBalance: balance - withdrawableBalance,
  };
}

function setBalanceBuckets(user, balance, withdrawableBalance) {
  if (!Number.isSafeInteger(balance) || balance < 0 ||
      !Number.isSafeInteger(withdrawableBalance) || withdrawableBalance < 0 ||
      withdrawableBalance > balance) {
    throw new Error('Balance update would create an invalid balance state.');
  }
  user.balance = balance;
  user.withdrawable_balance = withdrawableBalance;
}

function addDepositCredit(user, principal, eventBonus) {
  if (!Number.isSafeInteger(principal) || principal < 0 ||
      !Number.isSafeInteger(eventBonus) || eventBonus < 0) {
    throw new Error('Deposit credit amounts are invalid.');
  }

  const current = getBalanceBuckets(user);
  setBalanceBuckets(
    user,
    current.balance + principal + eventBonus,
    current.withdrawableBalance + principal
  );
}

function addWithdrawableCredit(user, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Withdrawable credit amount is invalid.');
  }

  const current = getBalanceBuckets(user);
  setBalanceBuckets(user, current.balance + amount, current.withdrawableBalance + amount);
}

function spendBalance(user, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Balance spend amount is invalid.');
  }

  const current = getBalanceBuckets(user);
  if (current.balance < amount) return null;

  const bonusSpent = Math.min(current.bonusBalance, amount);
  const withdrawableSpent = amount - bonusSpent;
  setBalanceBuckets(
    user,
    current.balance - amount,
    current.withdrawableBalance - withdrawableSpent
  );
  return { bonus_spent: bonusSpent, withdrawable_spent: withdrawableSpent };
}

function refundOrderBalance(user, orderId, order) {
  const amount = Number(order && order.price);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Order refund amount is invalid.');
  }

  const current = getBalanceBuckets(user);
  if (!user.order_refunds || typeof user.order_refunds !== 'object' || Array.isArray(user.order_refunds)) {
    user.order_refunds = {};
  }
  if (user.order_refunds[orderId]) return false;

  let withdrawableRefund = amount;
  const hasSpendBreakdown = Boolean(order) && (
    Object.prototype.hasOwnProperty.call(order, 'withdrawable_spent') ||
    Object.prototype.hasOwnProperty.call(order, 'bonus_spent')
  );
  if (hasSpendBreakdown) {
    const withdrawableSpent = Number(order.withdrawable_spent);
    const bonusSpent = Number(order.bonus_spent);
    if (!Number.isSafeInteger(withdrawableSpent) || withdrawableSpent < 0 ||
        !Number.isSafeInteger(bonusSpent) || bonusSpent < 0 ||
        withdrawableSpent + bonusSpent !== amount) {
      throw new Error('Order spend breakdown is invalid.');
    }
    withdrawableRefund = withdrawableSpent;
  }

  setBalanceBuckets(
    user,
    current.balance + amount,
    current.withdrawableBalance + withdrawableRefund
  );
  user.order_refunds[orderId] = Date.now();
  return true;
}

function adjustBalance(user, type, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0 ||
      !['add', 'subtract'].includes(type)) {
    throw new Error('Balance adjustment is invalid.');
  }

  const current = getBalanceBuckets(user);
  if (type === 'subtract' && current.balance < amount) return null;

  const bonusDeducted = type === 'subtract' ? Math.min(current.bonusBalance, amount) : 0;
  const withdrawableDelta = type === 'add'
    ? amount
    : -(amount - bonusDeducted);
  const balanceAfter = type === 'add'
    ? current.balance + amount
    : current.balance - amount;
  const withdrawableAfter = current.withdrawableBalance + withdrawableDelta;
  setBalanceBuckets(user, balanceAfter, withdrawableAfter);

  return {
    balance_before: current.balance,
    balance_after: balanceAfter,
    withdrawable_before: current.withdrawableBalance,
    withdrawable_after: withdrawableAfter,
    bonus_before: current.bonusBalance,
    bonus_after: balanceAfter - withdrawableAfter,
  };
}

module.exports = {
  getBalanceBuckets,
  addDepositCredit,
  addWithdrawableCredit,
  spendBalance,
  refundOrderBalance,
  adjustBalance,
};
