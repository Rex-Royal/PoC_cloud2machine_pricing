'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isSyntheticSampleConfig, parseMachineConfig } from '#firmware-core';
import { readZipArchiveAsync } from '#firmware-core';
import { AuthService, NULL_UUID } from '#cloud-client';
import { ALL_CUSTOMERS_ID, CoffeeMachineService } from '#fleet-sync';
import { DynamicPricingService } from '#fleet-sync';
import type {
  CustomerOption,
  DeviceGroup,
  FleetMachine,
  MachineSyncState,
  RawMachineConfigJson,
  UserProfile,
} from '#firmware-core';
import {
  readSavedMachineSnapshots,
  readSavedSelectionForCustomer,
  sanitizeMachineSnapshot,
  stripConfigCache,
  writeSavedMachineSnapshots,
  writeSavedSelectionForCustomer,
  writeSavedSessionState,
  type SavedSessionState,
} from '../utils/dashboardStorage.ts';
import { useLatestRef } from './useLatestRef.ts';

export interface UseFleetSelectionOptions {
  jwtToken: string | null;
  activeWorkspaceView: 'fleet' | 'pricing';
  getIsDispatching?: () => boolean;
  onPersistCustomerId?: (customerId: string) => void;
  onNavigateToPricing?: () => void;
  onCustomerChanged?: () => void;
  onConfigsLoaded?: (payload: {
    updatedArray: FleetMachine[];
    cmdStacksById: Record<string, string>;
  }) => void;
  onReconciledMachines?: (refreshedMachinesById: Map<string, FleetMachine>) => void;
}

export function useFleetSelection(options: UseFleetSelectionOptions) {
  const { jwtToken, activeWorkspaceView } = options;

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('ALL');
  const [machines, setMachines] = useState<FleetMachine[]>([]);
  const [machineFilterText, setMachineFilterText] = useState('');
  const [hideUnconfiguredDevices, setHideUnconfiguredDevices] = useState(false);
  const [selectedMachineIds, setSelectedMachineIds] = useState<Set<string>>(new Set());
  const [isLoadingFleet, setIsLoadingFleet] = useState(false);
  const [isLoadingConfigs, setIsLoadingConfigs] = useState(false);
  const [fleetStatusMessage, setFleetStatusMessage] = useState('');
  const [machineStatesById, setMachineStatesById] = useState<Record<string, MachineSyncState>>({});
  const [uploadTargetMachineId, setUploadTargetMachineId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attemptedConfigIdsRef = useRef<Set<string>>(new Set());
  const purgedSyntheticIdsRef = useRef<Set<string>>(new Set());
  const isFetchingFleetRef = useRef<boolean>(false);
  const isReconcilingRef = useRef<boolean>(false);
  const hasRestoredOnHmrRef = useRef<boolean>(false);
  const unreachableTrackerRef = useRef<
    Map<string, { lastConnectMs: number; lastProbedAtMs: number }>
  >(new Map());

  const selectedMachineIdsRef = useLatestRef(selectedMachineIds);
  const machinesRef = useLatestRef(machines);
  const getIsDispatchingRef = useLatestRef(options.getIsDispatching);
  const isLoadingConfigsRef = useLatestRef(isLoadingConfigs);
  const jwtTokenRef = useLatestRef(jwtToken);

  const onPersistCustomerIdRef = useLatestRef(options.onPersistCustomerId);
  const onNavigateToPricingRef = useLatestRef(options.onNavigateToPricing);
  const onCustomerChangedRef = useLatestRef(options.onCustomerChanged);
  const onConfigsLoadedRef = useLatestRef(options.onConfigsLoaded);
  const onReconciledMachinesRef = useLatestRef(options.onReconciledMachines);

  /**
   * Downloads `config.json` / `priceList.json` (from `Backup_MN*.zip`), `productlibrary.json`, and `cmdStack.json`
   * for target machines via `DynamicPricingService`.
   */
  const loadConfigsForMachines = useCallback(
    async (
      targetMachines: FleetMachine[],
      loadOptions: { quietStatus?: boolean; forceLiveRefresh?: boolean } = {}
    ) => {
      const { quietStatus = false, forceLiveRefresh = false } = loadOptions;
      if (targetMachines.length === 0) return;

      setIsLoadingConfigs(true);
      if (!quietStatus) {
        setFleetStatusMessage(
          forceLiveRefresh
            ? `Requesting live price list & layout from ${targetMachines.length} machine(s) / FtpProxy...`
            : `Loading current price list and layout from FtpProxy for ${targetMachines.length} machine(s)...`
        );
      }

      try {
        for (const m of targetMachines) {
          attemptedConfigIdsRef.current.add(m.id);
        }

        const { updatedById, cmdStacksById, syncStatesById, loadedCount, totalRecipes } =
          await DynamicPricingService.loadFleetPricingAndRecipes(targetMachines, {
            forceLiveRefresh,
          });

        const updatedArray = Array.from(updatedById.values());
        setMachines((prev) => prev.map((m) => updatedById.get(m.id) || m));
        setMachineStatesById((prev) => ({ ...prev, ...syncStatesById }));

        onConfigsLoadedRef.current?.({ updatedArray, cmdStacksById });

        const offlineUnavailableCount = updatedArray.filter(
          (m) => m.configSource === 'unavailable' && m.unavailableReason === 'offline_no_ftp_data'
        ).length;
        const unavailableSuffix =
          offlineUnavailableCount > 0
            ? ` (${offlineUnavailableCount} offline machine(s) have no FTP data and cannot be price-managed while offline.)`
            : '';

        if (loadedCount === 0) {
          setFleetStatusMessage(
            offlineUnavailableCount > 0
              ? `${offlineUnavailableCount} selected offline machine(s) have no config.json or backup on FtpProxy yet — they cannot be price-managed until they come online.`
              : `None of the ${targetMachines.length} selected machine(s) have a price list or config.json on FtpProxy yet.`
          );
        } else {
          const sampleCount = updatedArray.filter((m) => m.configSource === 'sample').length;
          const ftpCount = loadedCount - sampleCount;
          if (sampleCount > 0 && ftpCount === 0) {
            setFleetStatusMessage(
              `Loaded sample simulator layout (${totalRecipes} total screen products) for ${sampleCount} simulator machine(s).${unavailableSuffix}`
            );
          } else if (sampleCount > 0) {
            setFleetStatusMessage(
              `Loaded ${ftpCount} live machine price list(s) and ${sampleCount} sample simulator layout(s) (${totalRecipes} total screen products).${unavailableSuffix}`
            );
          } else {
            setFleetStatusMessage(
              `Loaded current price list & layout for ${loadedCount} of ${targetMachines.length} selected machine(s) (${totalRecipes} total screen products).${unavailableSuffix}`
            );
          }
        }
      } catch (err) {
        setFleetStatusMessage(
          `Failed to load configurations: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setIsLoadingConfigs(false);
      }
    },
    [onConfigsLoadedRef]
  );

  /**
   * Lists customer machines and updates live MQTT online/offline status (`cmConnected` / `active`).
   */
  const fetchCustomerDeviceList = useCallback(
    async (
      targetCustomerId: string,
      targetGroupId = 'ALL',
      fetchOptions: { silent?: boolean; preserveSelection?: boolean } = {}
    ): Promise<FleetMachine[]> => {
      const { silent = false, preserveSelection = false } = fetchOptions;
      if (!targetCustomerId) {
        if (!silent) {
          setMachines([]);
          setSelectedMachineIds(new Set());
        }
        return [];
      }

      if (silent && isFetchingFleetRef.current) {
        return [];
      }

      isFetchingFleetRef.current = true;
      if (!silent) {
        setIsLoadingFleet(true);
        setFleetStatusMessage('');
      }

      try {
        const deviceList = await CoffeeMachineService.listCustomerMachines(
          targetCustomerId,
          targetGroupId === 'ALL' ? null : targetGroupId,
          ''
        );

        if (silent || preserveSelection) {
          const snapshots = readSavedMachineSnapshots();
          setMachines((prevMachines) => {
            const prevById = new Map(
              prevMachines.map((m) => [m.id, sanitizeMachineSnapshot(m)])
            );
            const merged = deviceList.map((fresh) => {
              const unreachable = unreachableTrackerRef.current.get(fresh.id);
              const effectiveConnected =
                fresh.cmConnected &&
                unreachable &&
                unreachable.lastConnectMs === (fresh.lastConnectMs ?? 0)
                  ? false
                  : fresh.cmConnected;
              const freshAdjusted =
                effectiveConnected !== fresh.cmConnected
                  ? { ...fresh, cmConnected: false }
                  : fresh;
              const existing = prevById.get(fresh.id) || snapshots[fresh.id];
              if (!existing) return freshAdjusted;

              // If an unavailable offline machine just came ONLINE, clear unavailable state so we auto-load its live config
              if (
                existing.configSource === 'unavailable' &&
                freshAdjusted.cmConnected &&
                !existing.cmConnected
              ) {
                attemptedConfigIdsRef.current.delete(fresh.id);
                return freshAdjusted;
              }
              return {
                ...freshAdjusted,
                rawConfigJson: existing.rawConfigJson,
                rawProductLibraryJson: existing.rawProductLibraryJson,
                layout: existing.layout,
                configLoaded: existing.configLoaded,
                configHash: existing.configHash,
                configSource: existing.configSource,
                unavailableReason: existing.unavailableReason,
              };
            });

            const mergedIds = new Set(merged.map((m) => m.id));
            const preservedSelected: FleetMachine[] = [];
            for (const selId of selectedMachineIdsRef.current) {
              if (!mergedIds.has(selId)) {
                const found = prevById.get(selId) || snapshots[selId];
                if (found) {
                  preservedSelected.push(found);
                  mergedIds.add(selId);
                }
              }
            }
            return [...preservedSelected, ...merged];
          });

          if (!silent) {
            const onlineCount = deviceList.filter((m) => m.cmConnected).length;
            setFleetStatusMessage(
              `Found ${deviceList.length} machine(s) (${onlineCount} online).`
            );
          }
        } else {
          const savedIds = readSavedSelectionForCustomer(targetCustomerId);
          const snapshots = readSavedMachineSnapshots();
          const deviceById = new Map(deviceList.map((m) => [m.id, m]));
          const hydratedDeviceList = deviceList.map((fresh) => {
            const snap = snapshots[fresh.id];
            if (!snap) return fresh;
            return {
              ...fresh,
              rawConfigJson: snap.rawConfigJson,
              rawProductLibraryJson: snap.rawProductLibraryJson,
              layout: snap.layout,
              configLoaded: snap.configLoaded,
              configHash: snap.configHash,
              configSource: snap.configSource,
            };
          });

          const validIds = new Set<string>();
          const missingSelectedMachines: FleetMachine[] = [];
          const idsToFetchFromTb: string[] = [];
          for (const id of savedIds) {
            if (deviceById.has(id)) {
              validIds.add(id);
            } else if (snapshots[id]) {
              validIds.add(id);
              missingSelectedMachines.push(snapshots[id]);
            } else {
              idsToFetchFromTb.push(id);
            }
          }

          if (idsToFetchFromTb.length > 0) {
            const fetchedMissing = await CoffeeMachineService.getMachinesByIds(idsToFetchFromTb);
            if (fetchedMissing.length > 0) {
              writeSavedMachineSnapshots(fetchedMissing);
              for (const fm of fetchedMissing) {
                validIds.add(fm.id);
                missingSelectedMachines.push(fm);
              }
            }
          }

          const combinedDeviceList = [...missingSelectedMachines, ...hydratedDeviceList];
          setMachines(combinedDeviceList);
          setSelectedMachineIds(validIds);
          selectedMachineIdsRef.current = validIds;
          writeSavedSelectionForCustomer(targetCustomerId, validIds);

          const onlineCount = combinedDeviceList.filter((m) => m.cmConnected).length;
          const scopeDesc =
            targetCustomerId === ALL_CUSTOMERS_ID ? ' across all customers' : '';

          if (validIds.size > 0) {
            const restoredMachines = combinedDeviceList.filter(
              (m) => validIds.has(m.id) && !m.layout
            );
            setFleetStatusMessage(
              `Found ${deviceList.length} machine(s)${scopeDesc} (${onlineCount} online). Restored ${validIds.size} selected machine(s).`
            );
            if (restoredMachines.length > 0) {
              await loadConfigsForMachines(restoredMachines.slice(0, 25), {
                quietStatus: true,
              });
            }
          } else {
            setFleetStatusMessage(
              `Found ${deviceList.length} machine(s)${scopeDesc} (${onlineCount} online). Select the machine(s) you want to manage.`
            );
          }
        }
        return deviceList;
      } catch (err) {
        if (!silent) {
          setFleetStatusMessage(
            `Failed to query machine list: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return [];
      } finally {
        isFetchingFleetRef.current = false;
        if (!silent) {
          setIsLoadingFleet(false);
        }
      }
    },
    [loadConfigsForMachines, selectedMachineIdsRef]
  );

  const initializeFleetForProfile = useCallback(
    async (profile: UserProfile): Promise<string> => {
      const customerList = await AuthService.getAvailableCustomers(profile);
      setCustomers(customerList);

      const ownCustomerId =
        profile?.customerId?.id && profile.customerId.id !== NULL_UUID
          ? profile.customerId.id
          : customerList.length === 1
            ? customerList[0].id
            : ALL_CUSTOMERS_ID;

      setSelectedCustomerId(ownCustomerId);
      setSelectedGroupId('ALL');
      setMachines([]);
      setSelectedMachineIds(new Set());

      const grpList = await CoffeeMachineService.getCustomerDeviceGroups(ownCustomerId);
      setGroups(grpList);
      await fetchCustomerDeviceList(ownCustomerId, 'ALL');
      return ownCustomerId;
    },
    [fetchCustomerDeviceList]
  );

  const restoreFleetForProfile = useCallback(
    async (profile: UserProfile, saved: SavedSessionState): Promise<void> => {
      const customerList = await AuthService.getAvailableCustomers(profile);
      setCustomers(customerList);

      const initialCustomerId = saved.selectedCustomerId || ALL_CUSTOMERS_ID;
      setSelectedCustomerId(initialCustomerId);

      const grpList = await CoffeeMachineService.getCustomerDeviceGroups(initialCustomerId);
      setGroups(grpList);

      const loadedDevices = await fetchCustomerDeviceList(initialCustomerId, 'ALL');
      if (loadedDevices.length === 0 && initialCustomerId !== ALL_CUSTOMERS_ID) {
        setSelectedCustomerId(ALL_CUSTOMERS_ID);
        setGroups([]);
        writeSavedSessionState({
          ...saved,
          selectedCustomerId: ALL_CUSTOMERS_ID,
        });
        await fetchCustomerDeviceList(ALL_CUSTOMERS_ID, 'ALL');
      }
    },
    [fetchCustomerDeviceList]
  );

  const resetFleetOnLogout = useCallback(() => {
    setCustomers([]);
    setSelectedCustomerId('');
    setGroups([]);
    setSelectedGroupId('ALL');
    setMachines([]);
    setSelectedMachineIds(new Set());
    selectedMachineIdsRef.current = new Set();
    setFleetStatusMessage('');
  }, [selectedMachineIdsRef]);

  const handleSelectCustomer = useCallback(
    async (nextCustomerId: string) => {
      const resolvedCustomerId = nextCustomerId || ALL_CUSTOMERS_ID;
      attemptedConfigIdsRef.current.clear();
      setSelectedCustomerId(resolvedCustomerId);
      setSelectedGroupId('ALL');
      if (resolvedCustomerId !== ALL_CUSTOMERS_ID) {
        setMachineFilterText('');
      }
      setMachines([]);
      setSelectedMachineIds(new Set());
      onCustomerChangedRef.current?.();

      if (!jwtTokenRef.current) {
        setGroups([]);
        return;
      }

      onPersistCustomerIdRef.current?.(resolvedCustomerId);

      const grpList = await CoffeeMachineService.getCustomerDeviceGroups(resolvedCustomerId);
      setGroups(grpList);
      await fetchCustomerDeviceList(resolvedCustomerId, 'ALL');
    },
    [fetchCustomerDeviceList, jwtTokenRef, onCustomerChangedRef, onPersistCustomerIdRef]
  );

  const handleSelectGroup = useCallback(
    async (nextGroupId: string) => {
      setSelectedGroupId(nextGroupId);
      if (!jwtTokenRef.current || !selectedCustomerId) return;
      await fetchCustomerDeviceList(selectedCustomerId, nextGroupId);
    },
    [selectedCustomerId, fetchCustomerDeviceList, jwtTokenRef]
  );

  const handleRefreshFleet = useCallback(() => {
    if (!selectedCustomerId) return;
    void fetchCustomerDeviceList(selectedCustomerId, selectedGroupId, {
      preserveSelection: true,
    });
  }, [selectedCustomerId, selectedGroupId, fetchCustomerDeviceList]);

  const handleLoadSelectedConfigs = useCallback(async () => {
    if (!jwtTokenRef.current || selectedMachineIds.size === 0) return;
    onNavigateToPricingRef.current?.();
    const targetMachines = machines.filter((m) => selectedMachineIds.has(m.id));
    await loadConfigsForMachines(targetMachines);
  }, [
    jwtTokenRef,
    selectedMachineIds,
    machines,
    loadConfigsForMachines,
    onNavigateToPricingRef,
  ]);

  const handleLoadSingleMachineConfig = useCallback(
    async (machine: FleetMachine) => {
      if (!jwtTokenRef.current || !machine) return;
      setSelectedMachineIds((prev) => {
        const next = new Set(prev);
        next.add(machine.id);
        writeSavedSelectionForCustomer(selectedCustomerId, next);
        return next;
      });
      onNavigateToPricingRef.current?.();
      await loadConfigsForMachines([
        { ...stripConfigCache(machine), rawProductLibraryJson: null },
      ]);
    },
    [jwtTokenRef, selectedCustomerId, loadConfigsForMachines, onNavigateToPricingRef]
  );

  const recheckUnavailableMachines = useCallback(
    async (targetMachines: readonly FleetMachine[]) => {
      if (targetMachines.length === 0) return;
      const liveStubs = await CoffeeMachineService.getMachinesByIds(
        targetMachines.map((m) => m.id)
      );
      const liveMap = new Map(liveStubs.map((m) => [m.id, m]));
      const refreshedTargets = targetMachines.map((m) => {
        const fresh = liveMap.get(m.id);
        return stripConfigCache({
          ...m,
          cmConnected: fresh ? fresh.cmConnected : m.cmConnected,
        });
      });
      await loadConfigsForMachines(refreshedTargets, { forceLiveRefresh: true });
    },
    [loadConfigsForMachines]
  );

  const handleImportMachineConfig = useCallback((machineId: string) => {
    setUploadTargetMachineId(machineId);
    fileInputRef.current?.click();
  }, []);

  const handleManualFileImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !uploadTargetMachineId) return;

      try {
        let parsedJson: RawMachineConfigJson | null = null;
        if (file.name.toLowerCase().endsWith('.zip')) {
          const buf = new Uint8Array(await file.arrayBuffer());
          const entriesMap = await readZipArchiveAsync(buf);
          const priceJsonKey = Object.keys(entriesMap).find(
            (name) => name.endsWith('priceList.json') || name.endsWith('config.json')
          );
          if (!priceJsonKey) {
            throw new Error('ZIP archive does not contain priceList.json or config.json');
          }
          parsedJson = JSON.parse(entriesMap[priceJsonKey]) as RawMachineConfigJson;
        } else {
          const text = await file.text();
          parsedJson = JSON.parse(text) as RawMachineConfigJson;
        }

        const parsedLayout = parseMachineConfig(parsedJson);

        setMachines((prev) =>
          prev.map((m) =>
            m.id === uploadTargetMachineId
              ? {
                  ...m,
                  rawConfigJson: parsedJson,
                  layout: parsedLayout,
                  configLoaded: true,
                  configSource: 'imported',
                  unavailableReason: undefined,
                }
              : m
          )
        );
        setSelectedMachineIds((prev) => {
          const next = new Set(prev);
          next.add(uploadTargetMachineId);
          writeSavedSelectionForCustomer(selectedCustomerId, next);
          return next;
        });
        setFleetStatusMessage(
          `Imported ${file.name} (${parsedLayout.rows}×${parsedLayout.columns}, ${parsedLayout.products.length} recipes).`
        );
      } catch (err) {
        setFleetStatusMessage(
          `Failed to import file: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        event.target.value = '';
        setUploadTargetMachineId(null);
      }
    },
    [uploadTargetMachineId, selectedCustomerId]
  );

  const filteredMachines = useMemo(() => {
    const term = machineFilterText.toLowerCase().trim();
    return machines.filter((m) => {
      if (hideUnconfiguredDevices && !m.isConfiguredIdentity) {
        return false;
      }
      if (!term) return true;
      return [
        m.serialNumber,
        m.name,
        m.machineModel,
        m.machineType,
        m.location,
        m.customerName,
        m.deviceToken,
        m.id,
      ].some((f) => String(f || '').toLowerCase().includes(term));
    });
  }, [machines, machineFilterText, hideUnconfiguredDevices]);

  const selectedMachines = useMemo(
    () => machines.filter((m) => selectedMachineIds.has(m.id)),
    [machines, selectedMachineIds]
  );

  const configuredMachines = useMemo(
    () => selectedMachines.filter((m) => m.layout || m.rawConfigJson),
    [selectedMachines]
  );

  const unavailableSelectedMachines = useMemo(
    () =>
      selectedMachines.filter(
        (m) => !m.layout && !m.rawConfigJson && m.configSource === 'unavailable'
      ),
    [selectedMachines]
  );

  const activeCustomerName = useMemo(() => {
    if (!selectedCustomerId) return null;
    if (selectedCustomerId === ALL_CUSTOMERS_ID) return 'All Customers';
    return customers.find((c) => c.id === selectedCustomerId)?.name || null;
  }, [customers, selectedCustomerId]);

  const handleToggleMachineSelection = useCallback(
    (machineId: string) => {
      const targetMachine = machinesRef.current.find((m) => m.id === machineId);
      const willBeSelected = !selectedMachineIdsRef.current.has(machineId);

      if (willBeSelected && targetMachine) {
        writeSavedMachineSnapshots([targetMachine]);
      }

      setSelectedMachineIds((prev) => {
        const next = new Set(prev);
        if (next.has(machineId)) {
          next.delete(machineId);
        } else {
          next.add(machineId);
        }
        selectedMachineIdsRef.current = next;
        writeSavedSelectionForCustomer(selectedCustomerId, next);
        return next;
      });

      if (willBeSelected && targetMachine && !targetMachine.rawConfigJson && jwtTokenRef.current) {
        void loadConfigsForMachines([targetMachine], { quietStatus: true });
      }
    },
    [
      machinesRef,
      selectedMachineIdsRef,
      selectedCustomerId,
      jwtTokenRef,
      loadConfigsForMachines,
    ]
  );

  const handleSelectAllFiltered = useCallback(
    (checked: boolean) => {
      if (checked) {
        const next = new Set(filteredMachines.map((m) => m.id));
        setSelectedMachineIds(next);
        selectedMachineIdsRef.current = next;
        writeSavedSelectionForCustomer(selectedCustomerId, next);
        const unloaded = filteredMachines.filter((m) => !m.rawConfigJson).slice(0, 25);
        if (unloaded.length > 0 && jwtTokenRef.current) {
          void loadConfigsForMachines(unloaded, { quietStatus: true });
        }
      } else {
        const next = new Set<string>();
        setSelectedMachineIds(next);
        selectedMachineIdsRef.current = next;
        writeSavedSelectionForCustomer(selectedCustomerId, next);
      }
    },
    [
      filteredMachines,
      selectedMachineIdsRef,
      selectedCustomerId,
      jwtTokenRef,
      loadConfigsForMachines,
    ]
  );

  const handleClearSelection = useCallback(() => {
    handleSelectAllFiltered(false);
  }, [handleSelectAllFiltered]);

  // Live background polling (5s customer / 20s entire fleet + window focus, only in fleet selection view)
  useQuery({
    queryKey: ['fleet-poll', selectedCustomerId, selectedGroupId],
    enabled: Boolean(jwtToken && selectedCustomerId && activeWorkspaceView === 'fleet'),
    queryFn: async () => {
      await fetchCustomerDeviceList(selectedCustomerId, selectedGroupId, { silent: true });
      return true;
    },
    refetchInterval: selectedCustomerId === ALL_CUSTOMERS_ID ? 20_000 : 5_000,
    refetchOnWindowFocus: true,
  });

  // Automatically load recipe list & pricing for any checked machine not yet fetched (or holding a stale synthetic sample)
  useEffect(() => {
    if (!jwtToken || isLoadingConfigs || selectedMachineIds.size === 0) return;
    const unattemptedSelected = machines.filter((m) => {
      if (!selectedMachineIds.has(m.id)) return false;
      const isStaleSynthetic =
        (isSyntheticSampleConfig(m.rawConfigJson) || m.configSource === 'sample') &&
        !purgedSyntheticIdsRef.current.has(m.id);
      if (isStaleSynthetic) {
        purgedSyntheticIdsRef.current.add(m.id);
        return true;
      }
      return !m.rawConfigJson && !attemptedConfigIdsRef.current.has(m.id);
    });

    if (unattemptedSelected.length > 0) {
      void loadConfigsForMachines(
        unattemptedSelected.slice(0, 25).map((m) => stripConfigCache(m))
      );
    }
  }, [jwtToken, isLoadingConfigs, selectedMachineIds, machines, loadConfigsForMachines]);

  // HMR restore fallback when authenticated with customer selected but empty selection
  useEffect(() => {
    if (
      !hasRestoredOnHmrRef.current &&
      jwtToken &&
      selectedCustomerId &&
      selectedMachineIds.size === 0
    ) {
      hasRestoredOnHmrRef.current = true;
      void fetchCustomerDeviceList(selectedCustomerId, selectedGroupId);
    }
  }, [
    jwtToken,
    selectedCustomerId,
    selectedGroupId,
    selectedMachineIds.size,
    fetchCustomerDeviceList,
  ]);

  // Persist selected machine snapshots to localStorage
  useEffect(() => {
    if (selectedMachines.length > 0) {
      writeSavedMachineSnapshots(selectedMachines);
    }
  }, [selectedMachines]);

  /**
   * Continuous 8s background reconciler for ALL selected machines (runs even when 0 queue batches are pending):
   * updates `cmConnected` and syncs ground-truth `config.json` when `confighash.json` changes.
   */
  const reconcileSelectedMachinesNow = useCallback(async () => {
    if (
      !jwtToken ||
      isReconcilingRef.current ||
      getIsDispatchingRef.current?.() ||
      isLoadingConfigsRef.current
    ) {
      return;
    }
    const selIds = selectedMachineIdsRef.current;
    if (selIds.size === 0) return;
    const currentSelected = machinesRef.current.filter((m) => selIds.has(m.id));
    if (currentSelected.length === 0) return;

    isReconcilingRef.current = true;
    try {
      const { liveOnlineById, liveLastConnectMsById, refreshedMachinesById } =
        await DynamicPricingService.reconcileFleetLiveStatusAndConfigHashes(currentSelected, {
          unreachableTracker: unreachableTrackerRef.current,
        });

      if (Object.keys(liveOnlineById).length > 0 || refreshedMachinesById.size > 0) {
        let anyChanged = false;
        setMachines((prev) => {
          const next = prev.map((m) => {
            const refreshed = refreshedMachinesById.get(m.id);
            if (refreshed) {
              anyChanged = true;
              return refreshed;
            }
            const nextOnline = m.id in liveOnlineById ? liveOnlineById[m.id] : m.cmConnected;
            const nextLastConnectMs =
              m.id in liveLastConnectMsById ? liveLastConnectMsById[m.id] : m.lastConnectMs;
            if (nextOnline !== m.cmConnected || nextLastConnectMs !== m.lastConnectMs) {
              anyChanged = true;
              return {
                ...m,
                cmConnected: nextOnline,
                lastConnectMs: nextLastConnectMs,
              };
            }
            return m;
          });
          if (anyChanged && refreshedMachinesById.size > 0) {
            writeSavedMachineSnapshots(Array.from(refreshedMachinesById.values()));
          }
          return anyChanged ? next : prev;
        });

        if (refreshedMachinesById.size > 0) {
          onReconciledMachinesRef.current?.(refreshedMachinesById);
        }
      }
    } catch {
      // Ignore transient background reconciliation errors
    } finally {
      isReconcilingRef.current = false;
    }
  }, [
    jwtToken,
    getIsDispatchingRef,
    isLoadingConfigsRef,
    selectedMachineIdsRef,
    machinesRef,
    onReconciledMachinesRef,
  ]);

  useQuery({
    queryKey: ['machine-reconcile', selectedCustomerId, selectedMachineIds.size],
    enabled: Boolean(jwtToken && selectedMachineIds.size > 0),
    queryFn: async () => {
      await reconcileSelectedMachinesNow();
      return true;
    },
    refetchInterval: 8_000,
    refetchOnWindowFocus: true,
  });

  return {
    customers,
    selectedCustomerId,
    activeCustomerName,
    groups,
    selectedGroupId,
    machines,
    setMachines,
    filteredMachines,
    selectedMachines,
    configuredMachines,
    unavailableSelectedMachines,
    machineFilterText,
    setMachineFilterText,
    hideUnconfiguredDevices,
    setHideUnconfiguredDevices,
    selectedMachineIds,
    isLoadingFleet,
    isLoadingConfigs,
    fleetStatusMessage,
    setFleetStatusMessage,
    machineStatesById,
    setMachineStatesById,
    fileInputRef,
    unreachableTrackerRef,
    loadConfigsForMachines,
    fetchCustomerDeviceList,
    initializeFleetForProfile,
    restoreFleetForProfile,
    resetFleetOnLogout,
    handleSelectCustomer,
    handleSelectGroup,
    handleRefreshFleet,
    handleLoadSelectedConfigs,
    handleLoadSingleMachineConfig,
    recheckUnavailableMachines,
    handleImportMachineConfig,
    handleManualFileImport,
    handleToggleMachineSelection,
    handleSelectAllFiltered,
    handleClearSelection,
    reconcileSelectedMachinesNow,
  };
}
