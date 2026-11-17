'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthSession } from '../hooks/useAuthSession.ts';
import { useFleetSelection } from '../hooks/useFleetSelection.ts';
import { useOfflineQueueAndSchedules } from '../hooks/useOfflineQueueAndSchedules.ts';
import { usePricingGroups } from '../hooks/usePricingGroups.ts';
import {
  translate,
  type SupportedLocale,
  type TranslationKey,
} from '../i18n/translations.ts';
import type {
  FleetMachine,
  ScheduledPricingJob,
  TrackedDeploymentBatch,
  UserProfile,
} from '#firmware-core';
import type { SavedSessionState } from '../utils/dashboardStorage.ts';
import { AuthForm } from './auth/AuthForm.tsx';
import { DebuggerConsole } from './debug/DebuggerConsole.tsx';
import { FleetSelectionView } from './fleet/FleetSelectionView.tsx';
import { TopHeader, type WorkspaceStep } from './layout/TopHeader.tsx';
import { OfflineQueuePanel } from './pricing/OfflineQueuePanel.tsx';
import type { GroupScheduleState, PricingGroupCluster } from './pricing/PricingGroupsPanel.tsx';
import { PricingGroupsPanel } from './pricing/PricingGroupsPanel.tsx';
import { ProductsPricingTable } from './pricing/ProductsPricingTable.tsx';
import { UnavailableMachinesBanner } from './pricing/UnavailableMachinesBanner.tsx';

export default function DynamicPricingDashboard() {
  const [locale, setLocale] = useState<SupportedLocale>('en_US');
  const t = useCallback((key: TranslationKey) => translate(locale, key), [locale]);
  const [activeWorkspaceView, setActiveWorkspaceView] = useState<WorkspaceStep>('fleet');

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const fwdRef = useRef<{
    fleet?: {
      restoreFleetForProfile: (profile: UserProfile, saved: SavedSessionState) => Promise<void>;
      initializeFleetForProfile: (profile: UserProfile) => Promise<string>;
      resetFleetOnLogout: () => void;
    };
    pricing?: {
      isDispatching: boolean;
      resetPricingOnLogout: () => void;
      resetPricingOnCustomerChange: () => void;
      setEditedLayoutByGroup: (next: Record<string, never>) => void;
    };
    queue?: {
      recoverBatchesFromCmdStacks: (
        updatedArray: FleetMachine[],
        cmdStacksById: Record<string, string>
      ) => void;
      promoteConfirmedBatchRows: (refreshedMachinesById: Map<string, FleetMachine>) => void;
      getGroupScheduleState: (cluster: PricingGroupCluster | null) => GroupScheduleState;
      saveScheduledJob: (job: ScheduledPricingJob, groupKey: string) => void;
      appendDeploymentBatch: (batch: TrackedDeploymentBatch) => void;
      handleCheckOfflineQueueNow: () => Promise<void>;
    };
  }>({});

  const auth = useAuthSession({
    onSessionRestored: (profile, saved) =>
      fwdRef.current.fleet?.restoreFleetForProfile(profile, saved),
    onLoginSuccess: async (profile) =>
      (await fwdRef.current.fleet?.initializeFleetForProfile(profile)) ?? '',
    onLoggedOut: () => {
      fwdRef.current.fleet?.resetFleetOnLogout();
      fwdRef.current.pricing?.resetPricingOnLogout();
    },
    onCloseModal: () => dialogRef.current?.close(),
  });

  const fleet = useFleetSelection({
    jwtToken: auth.jwtToken,
    activeWorkspaceView,
    getIsDispatching: () => Boolean(fwdRef.current.pricing?.isDispatching),
    onPersistCustomerId: auth.persistSelectedCustomerId,
    onNavigateToPricing: () => setActiveWorkspaceView('pricing'),
    onCustomerChanged: () => fwdRef.current.pricing?.resetPricingOnCustomerChange(),
    onConfigsLoaded: ({ updatedArray, cmdStacksById }) => {
      fwdRef.current.pricing?.setEditedLayoutByGroup({});
      fwdRef.current.queue?.recoverBatchesFromCmdStacks(updatedArray, cmdStacksById);
    },
    onReconciledMachines: (refreshedMachinesById) =>
      fwdRef.current.queue?.promoteConfirmedBatchRows(refreshedMachinesById),
  });

  const pricing = usePricingGroups({
    jwtToken: auth.jwtToken,
    selectedCustomerId: fleet.selectedCustomerId,
    selectedMachines: fleet.selectedMachines,
    configuredMachines: fleet.configuredMachines,
    activeWorkspaceView,
    onRestoreWorkspaceView: setActiveWorkspaceView,
    loadConfigsForMachines: fleet.loadConfigsForMachines,
    setMachines: fleet.setMachines,
    setMachineStatesById: fleet.setMachineStatesById,
    setFleetStatusMessage: fleet.setFleetStatusMessage,
    getGroupScheduleState: (cluster) =>
      fwdRef.current.queue?.getGroupScheduleState(cluster) ?? {
        enabled: false,
        runAtLocal: '',
        savedJob: null,
      },
    onSaveScheduledJob: (job, groupKey) => fwdRef.current.queue?.saveScheduledJob(job, groupKey),
    onAppendDeploymentBatch: (batch) => fwdRef.current.queue?.appendDeploymentBatch(batch),
    onTriggerQueueCheck: () => void fwdRef.current.queue?.handleCheckOfflineQueueNow(),
    t,
  });

  const queueAndSchedules = useOfflineQueueAndSchedules({
    jwtToken: auth.jwtToken,
    selectedCustomerId: fleet.selectedCustomerId,
    machines: fleet.machines,
    clusters: pricing.clusters,
    activeCluster: pricing.activeCluster,
    unreachableTrackerRef: fleet.unreachableTrackerRef,
    setMachines: fleet.setMachines,
    setMachineStatesById: fleet.setMachineStatesById,
    setFleetStatusMessage: fleet.setFleetStatusMessage,
    setEditedLayoutByGroup: pricing.setEditedLayoutByGroup,
    setActiveClusterIndex: pricing.setActiveClusterIndex,
    setDeployFeedbackByGroup: pricing.setDeployFeedbackByGroup,
    t,
  });

  useEffect(() => {
    fwdRef.current = { fleet, pricing, queue: queueAndSchedules };
  });

  const handleStepChange = useCallback(
    (step: WorkspaceStep) => {
      setActiveWorkspaceView(step);
      if (step === 'pricing') {
        const unloaded = fleet.selectedMachines.filter((m) => !m.layout);
        if (unloaded.length > 0) {
          void fleet.loadConfigsForMachines(unloaded);
        }
      }
    },
    [fleet]
  );

  const handleLightDismiss = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      dialogRef.current.close();
    }
  };

  const sharedAuthProps = {
    selectedPresetId: auth.envPreset,
    tbBaseUrl: auth.tbBaseUrl,
    ftpBaseUrl: auth.ftpBaseUrl,
    username: auth.usernameInput,
    password: auth.passwordInput,
    bearerTokenInput: auth.rawTokenInput,
    showBearerInput: auth.useRawTokenMode,
    authError: auth.authError,
    isLoggingIn: auth.isAuthenticating,
    isAuthenticated: Boolean(auth.jwtToken),
    t,
    onPresetChange: auth.handlePresetChange,
    onTbUrlChange: auth.setTbBaseUrl,
    onFtpUrlChange: auth.setFtpBaseUrl,
    onUsernameChange: auth.setUsernameInput,
    onPasswordChange: auth.setPasswordInput,
    onBearerChange: auth.setRawTokenInput,
    onToggleBearerInput: auth.setUseRawTokenMode,
    onSubmit: auth.handleLogin,
  };

  return (
    <div className="app-shell">
      <input
        ref={fleet.fileInputRef}
        type="file"
        accept=".json,.zip"
        className="hidden-file-input"
        onChange={fleet.handleManualFileImport}
      />

      <TopHeader
        isAuthenticated={Boolean(auth.jwtToken)}
        userDisplayName={auth.userDisplayName}
        activeEnvLabel={auth.activeEnvLabel}
        activeCustomerName={fleet.activeCustomerName}
        locale={locale}
        onLocaleChange={setLocale}
        onOpenAccountModal={() => dialogRef.current?.showModal()}
        activeStep={activeWorkspaceView}
        onStepChange={handleStepChange}
        showStepper={Boolean(fleet.selectedCustomerId)}
        totalMachinesCount={fleet.machines.length}
        selectedMachinesCount={fleet.selectedMachineIds.size}
        t={t}
      />

      {!auth.jwtToken ? (
        <main className="login-shell">
          <section className="panel">
            <div className="panel-header">
              <h2>{t('loginTitle')}</h2>
            </div>
            <p className="panel-desc">{t('loginDesc')}</p>
            <AuthForm mode="login" {...sharedAuthProps} />
          </section>
        </main>
      ) : (
        <main className="workspace-main">
          {fleet.selectedCustomerId && activeWorkspaceView === 'fleet' && (
            <FleetSelectionView
              customers={fleet.customers}
              selectedCustomerId={fleet.selectedCustomerId}
              onSelectCustomer={fleet.handleSelectCustomer}
              groups={fleet.groups}
              selectedGroupId={fleet.selectedGroupId}
              onSelectGroup={fleet.handleSelectGroup}
              fleetStatusMessage={fleet.fleetStatusMessage}
              filteredMachines={fleet.filteredMachines}
              selectedMachines={fleet.selectedMachines}
              selectedMachineIds={fleet.selectedMachineIds}
              machineStatesById={fleet.machineStatesById}
              machineFilterText={fleet.machineFilterText}
              onMachineFilterTextChange={fleet.setMachineFilterText}
              hideUnconfiguredDevices={fleet.hideUnconfiguredDevices}
              onHideUnconfiguredDevicesChange={fleet.setHideUnconfiguredDevices}
              isLoadingFleet={fleet.isLoadingFleet}
              isLoadingConfigs={fleet.isLoadingConfigs}
              onRefreshFleet={fleet.handleRefreshFleet}
              onToggleMachineSelection={fleet.handleToggleMachineSelection}
              onSelectAllFiltered={fleet.handleSelectAllFiltered}
              onClearSelection={fleet.handleClearSelection}
              onLoadSingleMachineConfig={fleet.handleLoadSingleMachineConfig}
              onImportMachineConfig={fleet.handleImportMachineConfig}
              onProceedToPricing={fleet.handleLoadSelectedConfigs}
              t={t}
            />
          )}

          {fleet.selectedCustomerId && activeWorkspaceView === 'pricing' && (
            <>
              <UnavailableMachinesBanner
                machines={fleet.unavailableSelectedMachines}
                isRefreshing={fleet.isLoadingConfigs || fleet.isLoadingFleet}
                onRecheckStatus={() =>
                  fleet.recheckUnavailableMachines(fleet.unavailableSelectedMachines)
                }
                onImportMachineConfig={fleet.handleImportMachineConfig}
                onRemoveMachine={fleet.handleToggleMachineSelection}
                onBackToSelection={() => setActiveWorkspaceView('fleet')}
                t={t}
              />

              <PricingGroupsPanel
                clusters={pricing.clusters}
                selectedMachinesCount={fleet.selectedMachines.length}
                activeClusterIndex={pricing.activeClusterIndex}
                isLoadingConfigs={fleet.isLoadingConfigs}
                onSelectCluster={pricing.setActiveClusterIndex}
                onMoveMachineToGroup={pricing.handleMoveMachineToGroup}
                onMoveMachineToNewGroup={pricing.handleMoveMachineToNewGroup}
                onSyncPriceLists={() => void pricing.handleSyncPriceLists()}
                onBackToFleet={() => setActiveWorkspaceView('fleet')}
                getEffectiveMachineLayout={pricing.getEffectiveMachineLayout}
                getGroupScheduleState={queueAndSchedules.getGroupScheduleState}
                onToggleGroupSchedule={queueAndSchedules.handleToggleGroupSchedule}
                onChangeGroupScheduleTime={queueAndSchedules.handleChangeGroupScheduleTime}
                t={t}
              />

              {pricing.activeCluster && pricing.currentEditedLayout && (
                <ProductsPricingTable
                  cluster={pricing.activeCluster}
                  clusterIndex={pricing.activeClusterIndex}
                  editedLayout={pricing.currentEditedLayout}
                  baselineLayout={pricing.baselineLayout}
                  referenceMachine={pricing.referenceMachine}
                  scheduleEnabled={
                    queueAndSchedules.getGroupScheduleState(pricing.activeCluster).enabled
                  }
                  deployFeedback={
                    pricing.deployFeedbackByGroup[pricing.activeCluster.layoutKey] ?? null
                  }
                  isLoadingConfigs={fleet.isLoadingConfigs}
                  isDispatching={pricing.isDispatching}
                  onCellPriceChange={pricing.handleCellPriceChange}
                  onResetPrices={pricing.handleResetPrices}
                  onDeployCluster={pricing.handleDispatchCluster}
                  onFetchClusterPriceList={() =>
                    void pricing.handleSyncPriceLists({
                      cluster: pricing.activeCluster,
                      forceLiveRefresh: true,
                    })
                  }
                  t={t}
                />
              )}

              <OfflineQueuePanel
                deploymentBatches={queueAndSchedules.deploymentBatches}
                machines={fleet.machines}
                isCheckingQueue={queueAndSchedules.isCheckingQueue}
                onCheckQueueNow={() =>
                  void queueAndSchedules.handleCheckOfflineQueueNow({ manual: true })
                }
                onClearCompletedBatches={queueAndSchedules.handleClearCompletedBatches}
                onRestoreBatchBaseline={queueAndSchedules.handleRestoreBatchBaseline}
                onCancelAndDeleteBatch={queueAndSchedules.handleCancelAndDeleteBatch}
                onRemoveBatchRow={queueAndSchedules.handleRemoveBatchRow}
                onCancelQueuedMachine={queueAndSchedules.handleCancelQueuedMachine}
                t={t}
              />
            </>
          )}

          <DebuggerConsole />
        </main>
      )}

      <dialog
        ref={dialogRef}
        className="auth-dialog"
        aria-labelledby="auth-dialog-title"
        onClick={handleLightDismiss}
      >
        <div className="dialog-content">
          <div className="dialog-header">
            <h2 id="auth-dialog-title">{t('loginTitle')}</h2>
            <button
              type="button"
              className="btn-close"
              aria-label={t('dialogCloseBtn')}
              onClick={() => dialogRef.current?.close()}
            >
              ✕
            </button>
          </div>
          <p className="dialog-desc">{t('loginDesc')}</p>
          <AuthForm
            mode="modal"
            {...sharedAuthProps}
            currentUserEmail={auth.userDisplayName}
            onLogout={auth.handleLogout}
            onCloseModal={() => dialogRef.current?.close()}
          />
        </div>
      </dialog>
    </div>
  );
}
