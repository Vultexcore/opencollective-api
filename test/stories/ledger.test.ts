/**
 * This test is meant to test the common workflows for the ledger: record a contribution,
 * refund it, add platform tips, etc.
 */

import { expect } from 'chai';
import express from 'express';
import moment from 'moment';
import nock from 'nock';

import { run as runSettlementScript } from '../../cron/monthly/host-settlement';
import {
  PLATFORM_TIP_TRANSACTION_PROPERTIES,
  SETTLEMENT_EXPENSE_PROPERTIES,
} from '../../server/constants/transactions';
import { payExpense } from '../../server/graphql/common/expenses';
import { createRefundTransaction, executeOrder } from '../../server/lib/payments';
import models from '../../server/models';
import { fakeCollective, fakeHost, fakeOrder, fakePayoutMethod, fakeUser } from '../test-helpers/fake-data';
import { nockFixerRates, resetTestDB, snapshotLedger } from '../utils';

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'amount',
  'paymentProcessorFeeInHostCurrency',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'settlementStatus',
  'isRefund',
];

const SNAPSHOT_COLUMNS_MULTI_CURRENCIES = [
  ...SNAPSHOT_COLUMNS.slice(0, 3),
  'currency',
  'amountInHostCurrency',
  'hostCurrency',
  ...SNAPSHOT_COLUMNS.slice(3),
];

const RATES = {
  USD: { EUR: 0.84, JPY: 110.94 },
  EUR: { USD: 1.19, JPY: 132.45 },
  JPY: { EUR: 0.0075, USD: 0.009 },
};

/**
 * Setup all tests with a similar environment, the only variables being the host/collective currencies
 */
const setupTestData = async (hostCurrency, collectiveCurrency) => {
  // TODO: The setup should ideally insert other hosts and transactions to make sure the balance queries are filtering correctly
  await resetTestDB();
  const hostAdmin = await fakeUser();
  const host = await fakeHost({
    name: 'OSC',
    admin: hostAdmin.collective,
    currency: hostCurrency,
    plan: 'grow-plan-2021', // Use a plan with 15% host share,
  });
  await hostAdmin.populateRoles();
  await host.update({ HostCollectiveId: host.id, isActive: true });
  const secondHostAdmin = await fakeUser();
  const secondHost = await fakeHost({
    name: 'Foundation',
    admin: secondHostAdmin.collective,
    currency: hostCurrency,
    plan: 'grow-plan-2021', // Use a plan with 15% host share,
    settings: { crossHostContributions: true },
  });
  await secondHostAdmin.populateRoles();
  await secondHost.update({ HostCollectiveId: secondHost.id, isActive: true });
  const collective = await fakeCollective({
    HostCollectiveId: host.id,
    name: 'ESLint',
    hostFeePercent: 5,
    currency: collectiveCurrency,
  });
  const secondCollective = await fakeCollective({
    HostCollectiveId: secondHost.id,
    name: 'DI',
    hostFeePercent: 5,
    currency: collectiveCurrency,
  });
  const contributorUser = await fakeUser(undefined, { name: 'Ben' });
  const ocInc = await fakeHost({ name: 'OC Inc', id: PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId });
  await fakePayoutMethod({ type: 'OTHER', CollectiveId: ocInc.id }); // For the settlement expense
  await fakeUser({ id: SETTLEMENT_EXPENSE_PROPERTIES.UserId, name: 'Pia' });
  const baseOrderData = {
    description: `Financial contribution to ${collective.name}`,
    totalAmount: 10000,
    currency: collectiveCurrency,
    FromCollectiveId: contributorUser.CollectiveId,
    CollectiveId: collective.id,
    PaymentMethodId: null,
  };

  return { collective, secondCollective, host, secondHost, hostAdmin, ocInc, contributorUser, baseOrderData };
};

/**
 * Creates the settlement expenses and pay them
 */
const executeAllSettlement = async remoteUser => {
  await runSettlementScript(moment().add(1, 'month').toDate());
  const settlementExpense = await models.Expense.findOne();
  expect(settlementExpense, 'Settlement expense has not been created').to.exist;
  await settlementExpense.update({ status: 'APPROVED' });
  await payExpense(<express.Request>{ remoteUser }, { id: settlementExpense.id, forceManual: true });
};

describe('test/stories/ledger', () => {
  let collective, secondCollective, host, secondHost, hostAdmin, ocInc, contributorUser, baseOrderData;

  // Mock currency conversion rates, based on real rates from 2021-06-23
  before(() => {
    nockFixerRates(RATES);
  });

  after(() => {
    nock.cleanAll();
  });

  /** Check the validity of all transactions created during tests */
  afterEach(async () => {
    const transactions = await models.Transaction.findAll({ order: [['id', 'DESC']] });
    await Promise.all(
      transactions.map(transaction => models.Transaction.validate(transaction, { validateOppositeTransaction: true })),
    );
  });

  describe('Level 1: Same currency (USD)', () => {
    beforeEach(async () => {
      ({ collective, secondCollective, host, secondHost, hostAdmin, ocInc, contributorUser, baseOrderData } =
        await setupTestData('USD', 'USD'));
    });

    it('1. Simple contribution without host fees', async () => {
      await collective.update({ hostFeePercent: 0 });
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(10000);
      expect(await host.getTotalMoneyManaged()).to.eq(10000);
      expect(await host.getBalance()).to.eq(0);
      expect(await ocInc.getBalance()).to.eq(0);
    });

    it('2. Simple contribution with 5% host fees', async () => {
      const order = await fakeOrder(baseOrderData);
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(9500); // 1000 - 5% host fee
      expect(await host.getTotalMoneyManaged()).to.eq(10000);
      expect(await host.getBalance()).to.eq(500); // 5% host fee
      expect(await ocInc.getBalance()).to.eq(0);
    });

    it('3. Simple contribution with 5% host fees and indirect platform tip (unsettled)', async () => {
      const order = await fakeOrder({ ...baseOrderData, data: { isFeesOnTop: true, platformFee: 1000 } });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(8550); // (10000 Total - 1000 platform tip) - 5% host fee (450)
      expect(await host.getTotalMoneyManaged()).to.eq(10000); // Tip is still on host's account
      expect(await host.getBalance()).to.eq(1450);
      expect(await host.getBalanceWithBlockedFunds()).to.eq(1450);
      // TODO We should have a "Projected balance" that removes everything owed
      expect(await ocInc.getBalance()).to.eq(0);
    });

    it('4. Simple contribution with 5% host fees and indirect platform tip (settled)', async () => {
      // Create initial order
      const order = await fakeOrder({ ...baseOrderData, data: { isFeesOnTop: true, platformFee: 1000 } });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(8550); // (10000 Total - 1000 platform tip) - 5% host fee (450)
      expect(await host.getTotalMoneyManaged()).to.eq(8932); // 10000 - 1000 (platform tip) - 68 (host fee share)
      expect(await host.getBalance()).to.eq(382); // 450 (host fee) - 68 (host fee share)
      expect(await host.getBalanceWithBlockedFunds()).to.eq(382);
      expect(await ocInc.getBalance()).to.eq(1068); // 1000 (platform tip) + 98 (host fee share)
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(1068);
    });

    it('5. Refunded contribution with host fees, payment processor fees and indirect platform tip', async () => {
      // Create initial order
      const order = await fakeOrder({
        ...baseOrderData,
        data: { isFeesOnTop: true, platformFee: 1000, paymentProcessorFeeInHostCurrency: 200 },
      });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      // New checks for payment processor fees
      expect(await collective.getBalance()).to.eq(8350); // (10000 Total - 1000 platform tip) - 5% host fee (450) - 200 processor fees
      expect(await host.getTotalMoneyManaged()).to.eq(8732); // 10000 - 1000 (tip) - 200 (processor fee) - 68 (host fee share)

      // Check host metrics pre-refund
      let hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 450,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 1000,
        pendingPlatformTips: 0, // Already settled
        hostFeeShare: 68,
        pendingHostFeeShare: 0,
        hostFeeSharePercent: 15,
        settledHostFeeShare: 68,
        totalMoneyManaged: 8732,
      });

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: 'CONTRIBUTION', type: 'CREDIT' },
      });

      await createRefundTransaction(contributionTransaction, 0, null, null);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(0);
      expect(await host.getTotalMoneyManaged()).to.eq(-1268);
      expect(await host.getBalance()).to.eq(-1268); // Will be -200 after settlement (platform tip)
      expect(await host.getBalanceWithBlockedFunds()).to.eq(-1268);
      expect(await ocInc.getBalance()).to.eq(1068);
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(1068);

      // Check host metrics
      hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 0,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 0, // There was a 1000 tip, but it was refunded
        pendingPlatformTips: -1000,
        hostFeeShare: 68,
        hostFeeSharePercent: 15,
        pendingHostFeeShare: 0,
        settledHostFeeShare: 68, // TODO(Ledger): After refund, should it be -68?
        totalMoneyManaged: -1268,
      });

      // Run OC settlement
      // TODO: We should run the opposite settlement and check amount
    });

    it('6. Cross Host contribution with 5% host fees and indirect platform tip (unsettled)', async () => {
      // Add some money to the secondCollective balance
      await secondCollective.update({ hostFeePercent: 0 });
      const firstOrderData = {
        ...baseOrderData,
        CollectiveId: secondCollective.id,
        description: `Financial contribution to ${secondCollective.name}`,
      };
      const firstOrder = await fakeOrder(firstOrderData);
      firstOrder.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, firstOrder);

      // Donate from secondCollective to Collective
      const paymentMethod = await models.PaymentMethod.findOne({
        where: {
          service: 'opencollective',
          type: 'collective',
          CollectiveId: secondCollective.id,
        },
      });
      const orderData = {
        ...baseOrderData,
        FromCollectiveId: secondCollective.id,
        PaymentMethodId: paymentMethod.id,
        data: { isFeesOnTop: true, platformFee: 1000 },
      };
      const order = await fakeOrder(orderData);
      order.paymentMethod = paymentMethod;
      await executeOrder(contributorUser, order);

      await snapshotLedger(SNAPSHOT_COLUMNS);
      expect(await collective.getBalance()).to.eq(8550); // (10000 Total - 1000 platform tip - 450 host fee)
      expect(await secondHost.getTotalMoneyManaged()).to.eq(10000); // Contribution and Tip are still on Host account
      expect(await host.getTotalMoneyManaged()).to.eq(0); // Host has not received anything yet
      expect(await host.getBalance()).to.eq(-8550); // Host is porting the debt and waiting for settlement
      expect(await host.getBalanceWithBlockedFunds()).to.eq(-8550); //  Host is porting the debt and waiting for settlement
      // TODO We should have a "Projected balance" that removes everything owed
      expect(await ocInc.getBalance()).to.eq(0);
    });
  });

  describe('Level 2: Host with a different currency (Host=EUR, Collective=EUR)', () => {
    beforeEach(async () => {
      ({ collective, host, hostAdmin, ocInc, contributorUser, baseOrderData } = await setupTestData('EUR', 'EUR'));
    });

    it('Refunded contribution with host fees, payment processor fees and indirect platform tip', async () => {
      // Create initial order
      const order = await fakeOrder({
        ...baseOrderData,
        data: { isFeesOnTop: true, platformFee: 1000, paymentProcessorFeeInHostCurrency: 200 },
      });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      // Check data
      const hostToPlatformFxRate = RATES[host.currency]['USD'];
      expect(await host.getBalance()).to.eq(382);
      expect(await host.getBalanceWithBlockedFunds()).to.eq(382);
      expect(await ocInc.getBalance()).to.eq(Math.round(1068 * hostToPlatformFxRate));
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(Math.round(1068 * hostToPlatformFxRate));
      expect(await collective.getBalance()).to.eq(8350); // (10000 Total - 1000 platform tip) - 5% host fee (450) - 200 processor fees
      expect(await host.getTotalMoneyManaged()).to.eq(8732); // 10000 - 1000 - 200 - 68

      // Check host metrics pre-refund
      let hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 450,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 1000,
        pendingPlatformTips: 0, // Already settled
        hostFeeShare: 68,
        hostFeeSharePercent: 15,
        pendingHostFeeShare: 0,
        settledHostFeeShare: 68,
        totalMoneyManaged: 8732,
      });

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: 'CONTRIBUTION', type: 'CREDIT' },
      });

      await createRefundTransaction(contributionTransaction, 0, null, null);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      expect(await collective.getBalance()).to.eq(0);
      expect(await host.getTotalMoneyManaged()).to.eq(-1268);
      expect(await host.getBalance()).to.eq(-1268); // Will be +200 after settlement (platform tip refund) +68 (host fee share refund)
      expect(await host.getBalanceWithBlockedFunds()).to.eq(-1268);
      expect(await ocInc.getBalance()).to.eq(Math.round(1068 * hostToPlatformFxRate));
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(Math.round(1068 * hostToPlatformFxRate));

      // Check host metrics
      hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 0,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 0, // There was a 1000 tip, but it was refunded
        pendingPlatformTips: -1000,
        hostFeeShare: 68,
        hostFeeSharePercent: 15,
        pendingHostFeeShare: 0,
        settledHostFeeShare: 68,
        totalMoneyManaged: -1268,
      });

      // Run OC settlement
      // TODO: We should run the opposite settlement and check amount
    });
  });

  describe('Level 3: Host and collective with different currencies (Host=EUR, Collective=JPY) 🤯️', () => {
    beforeEach(async () => {
      ({ collective, host, hostAdmin, ocInc, contributorUser, baseOrderData } = await setupTestData('EUR', 'JPY'));
      await host.update({ settings: { ...host.settings, features: { crossCurrencyManualTransactions: true } } });
    });

    it('Refunded contribution with host fees, payment processor fees and indirect platform tip', async () => {
      const hostToPlatformFxRate = RATES[host.currency]['USD'];
      const collectiveToHostFxRate = RATES[collective.currency][host.currency];
      const hostToCollectiveFxRate = 1 / collectiveToHostFxRate; // This is how `calculateNetAmountInCollectiveCurrency` gets the reverse rate
      const platformTipInCollectiveCurrency = 10000000;
      const platformTipInHostCurrency = platformTipInCollectiveCurrency * collectiveToHostFxRate;
      const processorFeeInHostCurrency = 200;
      const processorFeeInCollectiveCurrency = Math.round(processorFeeInHostCurrency * hostToCollectiveFxRate);
      const orderAmountInCollectiveCurrency = 100000000;
      const orderAmountInHostCurrency = orderAmountInCollectiveCurrency * collectiveToHostFxRate;
      const orderNetAmountInHostCurrency = orderAmountInHostCurrency - platformTipInHostCurrency;
      const expectedHostFeeInHostCurrency = Math.round(orderNetAmountInHostCurrency * 0.05);
      const expectedHostFeeInCollectiveCurrency = Math.round(expectedHostFeeInHostCurrency * hostToCollectiveFxRate);
      const expectedHostFeeShareInHostCurrency = Math.round(expectedHostFeeInHostCurrency * 0.15);
      const expectedHostProfitInHostCurrency = expectedHostFeeInHostCurrency - expectedHostFeeShareInHostCurrency;
      const expectedPlatformProfitInHostCurrency = expectedHostFeeShareInHostCurrency + platformTipInHostCurrency;
      const expectedNetAmountInHostCurrency =
        orderNetAmountInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency;

      // Create initial order
      const order = await fakeOrder({
        ...baseOrderData,
        totalAmount: orderAmountInCollectiveCurrency, // JPY has a lower value, we need to set a higher amount to trigger the settlement
        data: {
          isFeesOnTop: true,
          platformFee: platformTipInCollectiveCurrency,
          paymentProcessorFeeInHostCurrency: processorFeeInHostCurrency,
        },
      });
      order.paymentMethod = { service: 'opencollective', type: 'manual', paid: true };
      await executeOrder(contributorUser, order);

      // Run host settlement
      await executeAllSettlement(hostAdmin);

      // Check data
      expect(await host.getBalance()).to.eq(expectedHostProfitInHostCurrency);
      expect(await host.getBalanceWithBlockedFunds()).to.eq(expectedHostProfitInHostCurrency);
      expect(await host.getTotalMoneyManaged()).to.eq(expectedNetAmountInHostCurrency);

      expect(await ocInc.getBalance()).to.eq(Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate));
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(
        Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate),
      );

      expect(await collective.getBalance()).to.eq(
        orderAmountInCollectiveCurrency -
          platformTipInCollectiveCurrency -
          expectedHostFeeInCollectiveCurrency -
          processorFeeInCollectiveCurrency,
      );

      // Check host metrics pre-refund
      let hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: expectedHostFeeInHostCurrency,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: Math.round((platformTipInCollectiveCurrency * RATES.JPY.USD) / RATES.EUR.USD),
        pendingPlatformTips: 0, // Already settled
        hostFeeShare: expectedHostFeeShareInHostCurrency,
        hostFeeSharePercent: 15,
        pendingHostFeeShare: 0,
        settledHostFeeShare: expectedHostFeeShareInHostCurrency,
        totalMoneyManaged: expectedNetAmountInHostCurrency,
      });

      // ---- Refund transaction -----
      const contributionTransaction = await models.Transaction.findOne({
        where: { OrderId: order.id, kind: 'CONTRIBUTION', type: 'CREDIT' },
      });

      await createRefundTransaction(contributionTransaction, 0, null, null);

      // Check data
      await snapshotLedger(SNAPSHOT_COLUMNS_MULTI_CURRENCIES);
      expect(await collective.getBalance()).to.eq(0);
      expect(await host.getTotalMoneyManaged()).to.eq(
        -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
      );
      expect(await host.getBalance()).to.eq(
        -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
      );
      expect(await host.getBalanceWithBlockedFunds()).to.eq(
        -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
      );
      expect(await ocInc.getBalance()).to.eq(Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate));
      expect(await ocInc.getBalanceWithBlockedFunds()).to.eq(
        Math.round(expectedPlatformProfitInHostCurrency * hostToPlatformFxRate),
      );

      // Check host metrics
      hostMetrics = await host.getHostMetrics();
      expect(hostMetrics).to.deep.equal({
        hostFees: 0,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 0, // There was a 1000 tip, but it was refunded
        pendingPlatformTips: -platformTipInHostCurrency,
        hostFeeShare: expectedHostFeeShareInHostCurrency,
        hostFeeSharePercent: 15,
        pendingHostFeeShare: 0,
        settledHostFeeShare: expectedHostFeeShareInHostCurrency,
        totalMoneyManaged: -platformTipInHostCurrency - processorFeeInHostCurrency - expectedHostFeeShareInHostCurrency,
      });

      // Run OC settlement
      // TODO: We should run the opposite settlement and check amount
    });
  });
});
