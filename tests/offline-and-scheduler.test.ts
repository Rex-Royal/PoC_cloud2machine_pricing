import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AuthService } from '#cloud-client';
import {
  appendCommandToCmdStack,
  BACKUP_DOWNLOAD_GRACE_MS,
  BackupCleanupStatus,
  buildApplyPricingRpcCommand,
  doesRawConfigMatchTargetPrices,
  evaluateDueScheduleAction,
  evaluateGroupOnlineReadiness,
  extractQueuedBackupEntriesFromCmdStack,
  filterSchedulesForGroup,
  isBatchReadyForBackupDeletion,
  parseMachineConfig,
  PriceScheduleStatus,
  removeBackupFileFromCmdStack,
  resolveClusterForScheduledJob,
  ScheduleRecurrence,
  updateSingleProductParam,
  type ScheduledPricingJob,
  type TrackedDeploymentBatch,
} from '#firmware-core';
import { CoffeeMachineService, DynamicPricingService } from '#fleet-sync';
import {
  applyEditedPricesToRawConfigJson,
  createCloudFetchRouter,
  makeCluster,
  makeRawConfig,
  makeScheduleJob,
  makeStubMachine,
  makeUnsignedTestJwt,
  resetCloudConnectionState,
} from './fixtures.ts';

afterEach(() => resetCloudConnectionState());

describe('Offline Machine Eligibility, Sync Queue & Backup Cleanup Lifecycle', () => {
  it('blocks offline machines with no FTP data instead of assigning a synthetic sample layout', async (t) => {
    t.mock.method(CoffeeMachineService, 'fetchMostRecentFtpConfig', async () => ({
      configJson: null,
      productLibraryJson: null,
      fromNewerBackupZip: false,
    }));
    t.mock.method(CoffeeMachineService, 'getCmdStack', async () => ({
      exists: false,
      content: '',
    }));

    const offlineNoFtp = makeStubMachine({ cmConnected: false });
    const result = await DynamicPricingService.fetchMachinePricingAndRecipes(offlineNoFtp);

    assert.equal(result.machine.configLoaded, false);
    assert.equal(result.machine.layout, null);
    assert.equal(result.machine.rawConfigJson, null);
    assert.equal(result.machine.configSource, 'unavailable');
    assert.equal(result.machine.unavailableReason, 'offline_no_ftp_data');
  });

  it('allows offline machines that already have real FTP configuration data', async (t) => {
    const realFtpConfig = makeRawConfig({
      rows: 2,
      columns: 4,
      categoryName: 'Hot Beverages',
      products: [
        { id: 1, name: 'Espresso', product: 4, '47': 350 },
        { id: 2, name: 'Cappuccino', product: 14, '47': 450 },
      ],
    });

    t.mock.method(CoffeeMachineService, 'fetchMostRecentFtpConfig', async () => ({
      configJson: realFtpConfig,
      productLibraryJson: null,
      fromNewerBackupZip: false,
    }));
    t.mock.method(CoffeeMachineService, 'downloadProductLibraryJson', async () => null);
    t.mock.method(CoffeeMachineService, 'getCmdStack', async () => ({
      exists: false,
      content: '',
    }));

    const offlineWithFtp = makeStubMachine({ cmConnected: false });
    const result = await DynamicPricingService.fetchMachinePricingAndRecipes(offlineWithFtp);

    assert.equal(result.machine.configLoaded, true);
    assert.ok(result.machine.layout);
    assert.equal(result.machine.layout?.products.length, 2);
    assert.equal(result.machine.configSource, 'ftp');
    assert.equal(result.machine.unavailableReason, undefined);
  });

  it('extracts, recovers, and cancels queued backup commands in cmdStack.json', () => {
    const cmdA = buildApplyPricingRpcCommand('cust-1', 'add_priceList_3x5x1_a.zip');
    const cmdB = buildApplyPricingRpcCommand('cust-1', 'add_priceList_3x5x1_b.zip');
    let stack = appendCommandToCmdStack('', cmdA);
    stack = appendCommandToCmdStack(stack, cmdB);

    const extracted = extractQueuedBackupEntriesFromCmdStack(stack);
    assert.equal(extracted.length, 2);
    assert.equal(extracted[0].sourceFile, 'add_priceList_3x5x1_a.zip');
    assert.equal(extracted[1].sourceFile, 'add_priceList_3x5x1_b.zip');

    const machine = makeStubMachine({ id: 'dev-offline-1', customerId: 'cust-1' });
    const recovered = DynamicPricingService.buildRecoveredBatchesFromCmdStacks(
      [machine],
      { 'dev-offline-1': stack },
      []
    );
    assert.equal(recovered.length, 2);
    assert.equal(recovered[0].backupCleanupStatus, BackupCleanupStatus.WaitingOfflineQueue);

    const afterCancelA = removeBackupFileFromCmdStack(stack, 'add_priceList_3x5x1_a.zip');
    const remaining = extractQueuedBackupEntriesFromCmdStack(afterCancelA);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sourceFile, 'add_priceList_3x5x1_b.zip');

    const afterCancelAll = removeBackupFileFromCmdStack(
      afterCancelA,
      'add_priceList_3x5x1_b.zip'
    );
    assert.equal(afterCancelAll, '');
  });

  it('only deletes add_priceList_*.zip after ALL offline machines sync AND download grace window elapses', () => {
    const t0 = Date.parse('2026-11-11T10:00:00.000Z');
    const pendingBatch: TrackedDeploymentBatch = {
      batchId: 'b-1',
      customerId: 'cust-1',
      groupKey: 'group-1',
      groupLabel: 'Group 1',
      zipFileName: 'add_priceList_3x5x1_group-1.zip',
      createdAtIso: new Date(t0).toISOString(),
      machines: [
        {
          machineId: 'm-online',
          machineLabel: 'SN-100202',
          serialNumber: 'SN-100202',
          customerId: 'cust-1',
          zipFileName: 'add_priceList_3x5x1_group-1.zip',
          queuedAtIso: new Date(t0).toISOString(),
          deliveryMode: 'online_rpc',
          cmConnected: true,
          hasPendingCmdStack: false,
          syncedAtIso: new Date(t0).toISOString(),
        },
        {
          machineId: 'm-offline',
          machineLabel: 'SN-100203',
          serialNumber: 'SN-100203',
          customerId: 'cust-1',
          zipFileName: 'add_priceList_3x5x1_group-1.zip',
          queuedAtIso: new Date(t0).toISOString(),
          deliveryMode: 'offline_cmdstack',
          cmConnected: false,
          hasPendingCmdStack: true,
          syncedAtIso: null,
        },
      ],
      allMachinesSyncedAtIso: null,
      backupCleanupStatus: BackupCleanupStatus.WaitingOfflineQueue,
      backupDeletedAtIso: null,
    };

    // Must NOT delete while m-offline still has pending cmdStack.json (even hours later)
    assert.equal(
      isBatchReadyForBackupDeletion(pendingBatch, [pendingBatch], t0 + 3_600_000),
      false
    );

    // Offline machine reconnects and consumes cmdStack.json at t1
    const t1 = t0 + 60_000;
    const syncedBatch: TrackedDeploymentBatch = {
      ...pendingBatch,
      machines: pendingBatch.machines.map((m) => ({
        ...m,
        cmConnected: true,
        hasPendingCmdStack: false,
        syncedAtIso: m.syncedAtIso || new Date(t1).toISOString(),
      })),
      allMachinesSyncedAtIso: new Date(t1).toISOString(),
      backupCleanupStatus: BackupCleanupStatus.WaitingDownloadGrace,
    };

    // Must wait for BACKUP_DOWNLOAD_GRACE_MS so ApplyBackup::WorkerThread finishes downloading .zip
    assert.equal(isBatchReadyForBackupDeletion(syncedBatch, [syncedBatch], t1 + 5_000), false);

    // Once grace window elapses, ready for automatic DELETE /api/v2/delete!
    assert.equal(
      isBatchReadyForBackupDeletion(
        syncedBatch,
        [syncedBatch],
        t1 + BACKUP_DOWNLOAD_GRACE_MS + 100
      ),
      true
    );
  });

  it('detects zombie-online machines via 2-way probe, dispatches single-shot RPC without SX-App V1 reboot loops, and supports Cancel & Delete', async (t) => {
    const oldRawConfig = makeRawConfig({
      rows: 2,
      columns: 4,
      categoryName: 'Hot Beverages',
      products: [
        {
          id: 1,
          name: 'Espresso',
          productType: '4',
          attributes: [
            { name: 'RecipeID', value: '1' },
            { name: 'M0801', value: '4' },
            { name: 'ProdName', value: 'Espresso' },
            { name: 'M1401', value: '350' },
          ],
        },
      ],
    });

    const oldLayout = parseMachineConfig(oldRawConfig);
    const editedLayout = updateSingleProductParam(oldLayout, 1, '47', 420);
    assert.equal(doesRawConfigMatchTargetPrices(oldRawConfig, editedLayout), false);

    // Simulate a powered-off "zombie-online" S2 machine inside ThingsBoard's 6m inactivityTimeout (cmConnected = true, live 2-way probe = false)
    const zombieMachine = makeStubMachine({
      id: 'sim-s2-100201',
      customerId: 'cust-1',
      serialNumber: 'SN-100201',
      name: 'Lobby S2 Machine',
      cmConnected: true,
      rawConfigJson: oldRawConfig,
      layout: oldLayout,
      configLoaded: true,
      configHash: 'hash-old-v1',
      configSource: 'ftp',
    });

    const cluster = makeCluster([zombieMachine], {
      zipFileName: 'add_priceList_2x4x1_group-3.zip',
      referenceLayout: oldLayout,
    });

    AuthService.configure({
      tbBaseUrl: 'https://iot.rex-royal.ch',
      ftpBaseUrl: 'https://iot.rex-royal.ch:8787',
      jwtToken: 'test-jwt',
      useLocalCorsProxy: false,
    });

    const router = createCloudFetchRouter({
      initialFtpFiles: {
        'Config/sim-s2-100201/config.json': JSON.stringify(oldRawConfig),
        'Config/sim-s2-100201/confighash.json': 'hash-old-v1',
      },
      machinesOnlineById: { 'sim-s2-100201': true },
      liveTwoWayAckById: { 'sim-s2-100201': false },
    });
    t.mock.method(globalThis, 'fetch', router.fetch);

    const getApplyBackupRpcCount = () =>
      router.state.rpcCalls.filter((c) => c.method === 'applyBackup').length;

    // 1. Deploy while S2 is powered off inside TB's 6m timeout (`cmConnected: true`, `probeMachineLiveRpc: false`):
    //    Immediately marks `cmConnected: false`, queues `cmdStack.json`, sends 0 `applyBackup` RPCs, and preserves `config.json`!
    const deployRes = await DynamicPricingService.deployPricingToLayoutGroup({
      customerId: 'cust-1',
      cluster,
      editedLayout,
      groupLabel: 'Group 3 (2×4)',
    });

    assert.equal(
      router.state.uploadedFiles.some((f) => f.fileName === 'config.json'),
      false,
      'Browser must never overwrite machine config.json'
    );
    assert.equal(deployRes.onlineDispatched, 0);
    assert.equal(deployRes.offlineQueued, 1);
    assert.equal(deployRes.updatedMachinesById.get('sim-s2-100201')?.cmConnected, false);
    assert.equal(deployRes.trackedBatch.machines[0].syncedAtIso, null);
    assert.equal(deployRes.trackedBatch.machines[0].hasPendingCmdStack, true);
    assert.equal(getApplyBackupRpcCount(), 0);

    // 2. Poll while machine is offline: backup .zip stays alive & item stays pending
    router.state.machinesOnlineById['sim-s2-100201'] = false;
    const poll1 = await DynamicPricingService.syncOfflineQueueAndCleanupBackups([
      deployRes.trackedBatch,
    ]);
    assert.equal(poll1.batches[0].machines[0].syncedAtIso, null);
    assert.equal(
      router.state.deletedFiles.filter((d) => d.type === 'Backup').length,
      0,
      'Must NOT delete backup .zip before machine applies it'
    );

    // 3. Physical S2 (`SX-App` V1) boots up (`cmConnected: true`, `probeMachineLiveRpc: true`):
    //    Poller removes `cmdStack.json` FIRST (preventing a 2nd reboot at t+2m30s) and sends `applyBackup` ONCE!
    router.state.machinesOnlineById['sim-s2-100201'] = true;
    router.state.liveTwoWayAckById['sim-s2-100201'] = true;
    const poll2 = await DynamicPricingService.syncOfflineQueueAndCleanupBackups(poll1.batches);
    assert.equal(
      getApplyBackupRpcCount(),
      1,
      'Must send applyBackup RPC exactly once on live reconnect'
    );
    assert.equal(
      router.state.ftpFiles.get('Config/sim-s2-100201/cmdStack.json') ?? '',
      '',
      'Must clear cmdStack.json BEFORE sending live applyBackup RPC so SX-App V1 never double-reboots'
    );
    assert.equal(poll2.batches[0].machines[0].rpcAckedLive, true);
    assert.ok(poll2.batches[0].machines[0].syncedAtIso);

    // 4. Simulate SX-App V1 restarting (`cmConnected: true -> false -> true`) while `config.json` is NOT uploaded yet
    //    (takes 2–3 minutes of `nIdleCounter > 1` on SX-App V1): MUST NEVER re-send `applyBackup` RPC!
    router.state.machinesOnlineById['sim-s2-100201'] = false;
    const pollDuringRestartDisconnect = await DynamicPricingService.syncOfflineQueueAndCleanupBackups(
      poll2.batches
    );
    router.state.machinesOnlineById['sim-s2-100201'] = true;
    const pollAfterAppRestart = await DynamicPricingService.syncOfflineQueueAndCleanupBackups(
      pollDuringRestartDisconnect.batches
    );
    assert.equal(
      getApplyBackupRpcCount(),
      1,
      'Must NEVER re-send applyBackup RPC after SX-App V1 restart blip (prevents infinite reboot loop)'
    );

    // 5. Machine uploads updated `config.json` + `confighash.json` -> confirmed & `.zip` deleted!
    router.state.ftpFiles.set(
      'Config/sim-s2-100201/config.json',
      JSON.stringify(applyEditedPricesToRawConfigJson(oldRawConfig, editedLayout))
    );
    router.state.ftpFiles.set('Config/sim-s2-100201/confighash.json', 'hash-new-v2');
    const pollConfirmed = await DynamicPricingService.syncOfflineQueueAndCleanupBackups(
      pollAfterAppRestart.batches
    );
    assert.equal(pollConfirmed.batches[0].machines[0].confirmedByConfigJson, true);
    assert.equal(pollConfirmed.batches[0].backupCleanupStatus, BackupCleanupStatus.Deleted);
    assert.deepEqual(
      router.state.deletedFiles.filter((d) => d.type === 'Backup').map((d) => d.file),
      ['add_priceList_2x4x1_group-3.zip']
    );

    // 6. Verify Cancel & Delete works immediately even if a batch has NOT been sent/confirmed yet
    router.state.machinesOnlineById['sim-s2-100201'] = false;
    router.state.liveTwoWayAckById['sim-s2-100201'] = false;
    const secondDeploy = await DynamicPricingService.deployPricingToLayoutGroup({
      customerId: 'cust-1',
      cluster: { ...cluster, machines: [{ ...zombieMachine, cmConnected: false }] },
      editedLayout,
      groupLabel: 'Group 3 (Pending)',
    });
    const pendingStack = String(
      router.state.ftpFiles.get('Config/sim-s2-100201/cmdStack.json') ?? ''
    );
    assert.ok(pendingStack.length > 0);

    const cancelRes = await DynamicPricingService.cancelAndDeleteDeploymentBatch(
      secondDeploy.trackedBatch,
      [secondDeploy.trackedBatch]
    );
    assert.equal(cancelRes.deletedZip, true);
    assert.equal(cancelRes.remainingBatches.length, 0);
    assert.equal(router.state.ftpFiles.get('Config/sim-s2-100201/cmdStack.json') ?? '', '');
  });

  it('reconciles automatic disconnects + confighash.json updates and queries live machine on forceLiveRefresh', async (t) => {
    const staleCloudConfig = makeRawConfig({
      rows: 3,
      columns: 4,
      categoryName: 'Beverage',
      products: [
        { id: 1, name: 'Coffee', product: 2, '47': 200 },
        { id: 2, name: '2x Coffee', product: 3, '47': 200 },
      ],
    });
    const actualMachineConfig = makeRawConfig({
      rows: 3,
      columns: 4,
      categoryName: 'Beverage',
      products: [
        { id: 1, name: 'Coffee', product: 2, '47': 100 },
        { id: 2, name: '2x Coffee', product: 3, '47': 100 },
      ],
    });

    const cachedMachine = makeStubMachine({
      id: '00000000-0000-4000-8000-000000000002',
      serialNumber: 'SN-100201',
      cmConnected: true,
      rawConfigJson: staleCloudConfig,
      layout: parseMachineConfig(staleCloudConfig),
      configLoaded: true,
      configHash: 'stale-hash-200',
      configSource: 'ftp',
    });

    // 1. Even while ThingsBoard is STILL stuck at `cmConnected: true` inside its 6-minute (360s) MQTT keep-alive
    //    window after a machine is powered off, 2-way `probeMachineLiveRpc` (`false`) immediately marks it `Offline`
    //    AND `confighash.json` reconciliation syncs true `1.00` prices!
    const tracker = new Map<string, { lastConnectMs: number; lastProbedAtMs: number }>();
    t.mock.method(CoffeeMachineService, 'getMachinesByIds', async () => [
      makeStubMachine({
        id: cachedMachine.id,
        cmConnected: true,
        lastConnectMs: 1794406748422,
      }),
    ]);
    t.mock.method(CoffeeMachineService, 'probeMachineLiveRpc', async () => false);
    t.mock.method(CoffeeMachineService, 'downloadConfigHash', async () => 'fresh-hash-100');
    t.mock.method(CoffeeMachineService, 'downloadConfigJson', async () => actualMachineConfig);

    const reconciled = await DynamicPricingService.reconcileFleetLiveStatusAndConfigHashes(
      [cachedMachine],
      { unreachableTracker: tracker, retryDelayMs: 0 }
    );
    assert.equal(
      reconciled.liveOnlineById[cachedMachine.id],
      false,
      'Must flip powered-off machine to Offline immediately without waiting 6 minutes for ThingsBoard cmConnected'
    );
    assert.equal(tracker.get(cachedMachine.id)?.lastConnectMs, 1794406748422);
    const refreshed = reconciled.refreshedMachinesById.get(cachedMachine.id);
    assert.ok(refreshed);
    assert.equal(refreshed.cmConnected, false);
    assert.equal(refreshed.configHash, 'fresh-hash-100');
    assert.equal(refreshed.layout?.products[0].params['47'], 100);
    assert.equal(refreshed.layout?.products[1].params['47'], 100);

    // 2. Explicit `Fetch Current Price List` (`forceLiveRefresh: true`) on a live machine queries
    //    `requestConfigFromOnlineMachine` FIRST rather than returning stale FTP `config.json`!
    t.mock.method(CoffeeMachineService, 'getMachinesByIds', async () => [
      makeStubMachine({ id: cachedMachine.id, cmConnected: true }),
    ]);
    t.mock.method(CoffeeMachineService, 'probeMachineLiveRpc', async () => true);
    let requestedLiveExport = false;
    t.mock.method(CoffeeMachineService, 'requestConfigFromOnlineMachine', async () => {
      requestedLiveExport = true;
      return {
        configJson: actualMachineConfig,
        productLibraryJson: null,
        isFreshMachineExport: true,
      };
    });
    t.mock.method(CoffeeMachineService, 'downloadProductLibraryJson', async () => null);
    t.mock.method(CoffeeMachineService, 'getCmdStack', async () => ({
      exists: false,
      content: '',
    }));

    const liveFetched = await DynamicPricingService.fetchMachinePricingAndRecipes(cachedMachine, {
      forceLiveRefresh: true,
    });
    assert.equal(requestedLiveExport, true);
    assert.equal(liveFetched.machine.layout?.products[0].params['47'], 100);
  });
});

describe('Scheduled Dynamic Pricing & Online Readiness', () => {
  it('evaluates group online readiness and triggers scheduled apply + auto-revert windows', () => {
    const readinessMixed = evaluateGroupOnlineReadiness([
      makeStubMachine({ id: '1', serialNumber: 'SN-100202', cmConnected: true }),
      makeStubMachine({ id: '2', serialNumber: 'SN-100203', name: 'Lobby S2', cmConnected: false }),
    ]);
    assert.equal(readinessMixed.allOnline, false);
    assert.equal(readinessMixed.onlineCount, 1);
    assert.equal(readinessMixed.offlineCount, 1);
    assert.deepEqual(readinessMixed.offlineMachineLabels, ['SN-100203 · Lobby S2']);

    const job = makeScheduleJob();

    // Wednesday 13:30 local -> not due yet
    assert.equal(evaluateDueScheduleAction(job, new Date(2026, 10, 11, 13, 30)), null);

    // Wednesday 14:05 local -> due for 'apply'
    const applyDue = evaluateDueScheduleAction(job, new Date(2026, 10, 11, 14, 5));
    assert.deepEqual(applyDue, { type: 'apply', windowKey: '2026-11-11:14:00' });

    // Once applied, inside window -> no duplicate trigger
    const activeJob: ScheduledPricingJob = {
      ...job,
      status: PriceScheduleStatus.ActiveWindow,
      lastTriggeredWindowKey: '2026-11-11:14:00',
    };
    assert.equal(evaluateDueScheduleAction(activeJob, new Date(2026, 10, 11, 15, 0)), null);

    // Wednesday 17:01 local -> due for 'revert' back to baseline prices!
    const revertDue = evaluateDueScheduleAction(activeJob, new Date(2026, 10, 11, 17, 1));
    assert.deepEqual(revertDue, { type: 'revert', windowKey: '2026-11-11:14:00' });

    // Saturday 14:30 local -> Weekdays recurrence does NOT fire on weekend
    const revertedJob: ScheduledPricingJob = {
      ...activeJob,
      status: PriceScheduleStatus.Scheduled,
      lastRevertedWindowKey: '2026-11-11:14:00',
    };
    assert.equal(evaluateDueScheduleAction(revertedJob, new Date(2026, 10, 14, 14, 30)), null);
  });

  it('dynamically binds schedules to the Group (including machines added later to that Group)', () => {
    const layout = parseMachineConfig(makeRawConfig());
    const machineA = makeStubMachine({ id: 'm-a', serialNumber: 'SN-100202', layout });
    const machineB = makeStubMachine({ id: 'm-b', serialNumber: '999999', layout });

    // Schedule created when Group only had machineA
    const groupSchedule = makeScheduleJob({
      id: 'sched-group-1',
      name: 'Group 1 · -20%',
      groupKey: `auto-${layout.layoutKey}`,
      groupLabel: 'Group 1 (3×5)',
      zipFileName: 'add_priceList_sched_grp1.zip',
      machineIds: ['m-a'],
      targetLayout: layout,
      revertLayout: layout,
      recurrence: ScheduleRecurrence.Daily,
    });

    // Later, machineB joins the exact same Group in the Group UI
    const liveGroupCluster = makeCluster([machineA, machineB], {
      referenceLayout: layout,
    });

    const resolved = resolveClusterForScheduledJob(groupSchedule, [liveGroupCluster]);
    assert.ok(resolved);
    assert.deepEqual(
      resolved.machines.map((m) => m.id),
      ['m-a', 'm-b']
    );

    const groupJobs = filterSchedulesForGroup(liveGroupCluster, [liveGroupCluster], [
      groupSchedule,
    ]);
    assert.equal(groupJobs.length, 1);
    assert.equal(groupJobs[0].id, 'sched-group-1');
  });

  it('proactively renews a near-expiry JWT via POST /api/auth/token before scheduled triggers', async (t) => {
    const nowMs = Date.parse('2026-11-11T12:00:00.000Z');
    const expiringSoonJwt = makeUnsignedTestJwt(Math.floor((nowMs + 120_000) / 1000)); // +2 min
    const renewedJwt = makeUnsignedTestJwt(Math.floor((nowMs + 3_600_000) / 1000)); // +60 min

    assert.equal(AuthService.getTokenExpirationMs(expiringSoonJwt), nowMs + 120_000);

    AuthService.configure({
      tbBaseUrl: 'https://iot.rex-royal.ch',
      jwtToken: expiringSoonJwt,
      refreshToken: 'synthetic-refresh-1',
      useLocalCorsProxy: false,
    });

    const notifiedTokens: Array<{ jwtToken: string | null; refreshToken: string | null }> = [];
    const unsubscribe = AuthService.subscribeTokens((tokens) => notifiedTokens.push(tokens));

    let capturedUrl = '';
    let capturedBody = '';
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({ token: renewedJwt, refreshToken: 'synthetic-refresh-2' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    try {
      const res = await AuthService.ensureFreshToken({
        minValidityMs: 5 * 60_000,
        nowMs,
      });
      assert.equal(res.refreshed, true);
      assert.equal(res.token, renewedJwt);
      assert.equal(res.refreshToken, 'synthetic-refresh-2');
      assert.equal(capturedUrl, 'https://iot.rex-royal.ch/api/auth/token');
      assert.deepEqual(JSON.parse(capturedBody), { refreshToken: 'synthetic-refresh-1' });
      assert.equal(notifiedTokens.length, 1);
      assert.equal(notifiedTokens[0].jwtToken, renewedJwt);

      // Subsequent check with >55m validity remaining must NOT re-fetch
      const second = await AuthService.ensureFreshToken({
        minValidityMs: 5 * 60_000,
        nowMs,
      });
      assert.equal(second.refreshed, false);
    } finally {
      unsubscribe();
    }
  });
});
