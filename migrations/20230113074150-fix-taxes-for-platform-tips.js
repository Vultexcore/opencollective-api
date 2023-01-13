'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Remove taxes from platform tips. Thankfully, all these transactions were initiated from Stripe
    // so there's not PLATFORM_TIP_DEBT transactions to worry about.
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET
        "taxAmount" = 0,
        
      WHERE "kind" = 'PLATFORM_TIP'
      AND "taxAmount" < 0
    `);
  },

  async down() {
    console.log('This migration cannot be reverted');
  },
};
