'use strict';

function isAdminUser(user) {
  return Boolean(user && (
    user.admin === true ||
    (process.env.ADMIN_SECRET_UID && user.uid === process.env.ADMIN_SECRET_UID)
  ));
}

module.exports = isAdminUser;
