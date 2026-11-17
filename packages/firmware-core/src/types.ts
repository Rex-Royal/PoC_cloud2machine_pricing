/**
 * Strict TypeScript Enums & Domain Contracts for Rex-Royal Dynamic Pricing.
 */

export enum ApiBasePath {
  ThingsBoard = '/api',
  FtpV2 = '/api/v2',
}

export enum ProxyRoutePrefix {
  ThingsBoard = '/api-bridge/tb/api',
  FtpV2 = '/api-bridge/ftp/api/v2',
}

export enum AuthHeader {
  ThingsBoard = 'X-Authorization',
  FtpV2 = 'Authorization',
}

export enum EntityType {
  Customer = 'CUSTOMER',
  Device = 'DEVICE',
}

export enum FtpResourceType {
  Config = 'Config',
  Backup = 'Backup',
}

export enum MachineConfigFile {
  ConfigJson = 'config.json',
  ConfigHashJson = 'confighash.json',
  ProductLibraryJson = 'productlibrary.json',
  CmdStackJson = 'cmdStack.json',
  PriceListJson = 'priceList.json',
}

export enum MachineRpcMethod {
  ApplyBackup = 'applyBackup',
}

export enum MimeType {
  Json = 'application/json',
  Zip = 'application/zip',
}

export enum MachineSyncState {
  Synced = 'SYNCED',
  Pending = 'PENDING',
  Processing = 'PROCESSING',
  Desync = 'DESYNC',
  Failed = 'FAILED',
}

export enum BackupCleanupStatus {
  WaitingOfflineQueue = 'WAITING_OFFLINE_QUEUE',
  WaitingDownloadGrace = 'WAITING_DOWNLOAD_GRACE',
  Deleted = 'DELETED',
  DeleteFailed = 'DELETE_FAILED',
}

export enum ScheduleRecurrence {
  Once = 'ONCE',
  Daily = 'DAILY',
  Weekdays = 'WEEKDAYS',
  Weekends = 'WEEKENDS',
}

export enum PriceScheduleStatus {
  Scheduled = 'SCHEDULED',
  ActiveWindow = 'ACTIVE_WINDOW',
  Completed = 'COMPLETED',
  Paused = 'PAUSED',
}

export enum PriceListGroup {
  PL1 = 'PL1',
  PL2 = 'PL2',
  PL3 = 'PL3',
  PLU = 'PLU',
}

export enum PricingRuleMode {
  PercentChange = 'PERCENT_CHANGE',
  FlatOffset = 'FLAT_OFFSET',
  TierPriceList2And3 = 'TIER_PRICELIST_2_3',
  FreeVend = 'FREE_VEND',
}

export enum BeverageFilter {
  All = 'ALL',
  MilkDrinks = 'MILK_DRINKS',
}

export enum PricingPresetId {
  HappyHour20Off = 'HAPPY_HOUR_20_OFF',
  MorningMilkSurge = 'MORNING_MILK_SURGE',
  EmployeeSubsidizedTiers = 'EMPLOYEE_SUBSIDIZED_TIERS',
  FreeVendEvent = 'FREE_VEND_EVENT',
}

export type PriceParamCode =
  | '47' | '48' | '91' | '49'
  | '50' | '51' | '92' | '52'
  | '53' | '54' | '93' | '55'
  | '56' | '57' | '94' | '58'
  | '59' | '60' | '95' | '61'
  | '62' | '63' | '96' | '64'
  | '65' | '68' | '66' | '69'
  | '97' | '98' | '67' | '70';

export type PriceGrinderKey = 'Gr1' | 'Gr2' | 'Gr3' | 'Decaf';
export type PriceCupSize = 'Single' | 'Double';

export interface PriceParamSpec {
  readonly paramId: PriceParamCode;
  readonly enumName: string;
  readonly configNames: readonly string[];
  readonly group: PriceListGroup;
  readonly grinder: PriceGrinderKey;
  readonly cupSize: PriceCupSize;
  readonly variant: string;
  readonly isPrice: boolean;
}

export type PriceParamsRecord = Record<PriceParamCode, number>;

export interface RawConfigAttribute {
  name?: string;
  id?: string;
  value?: string | number;
}

export interface RawConfigProductNode {
  id?: number | string;
  name?: string;
  product?: number | string;
  productType?: number | string;
  attributes?: RawConfigAttribute[];
  extendedCupSize?: RawConfigProductNode[];
  [paramCode: string]: unknown;
}

export interface RawConfigCategoryNode {
  id?: number | string;
  catNumber?: number | string;
  name?: string;
  products?: RawConfigProductNode[];
}

export interface RawMachineConfigJson {
  rows?: number | string;
  columns?: number | string;
  categories?: number | string;
  selfService?: number | string;
  ignoreRecipeMatch?: number | boolean;
  prodCatArray?: RawConfigCategoryNode[];
  extendedCupSize?: RawConfigProductNode[];
  products?: RawConfigProductNode[];
  [key: string]: unknown;
}

export interface RawProductLibraryJson {
  products?: RawConfigProductNode[];
  [key: string]: unknown;
}

export interface ProductSlot {
  readonly id: number;
  readonly categoryIndex: number;
  readonly product: number;
  readonly productTypeKey: string;
  readonly name: string;
  readonly displayName: string;
  readonly isExtended: boolean;
  readonly isLocked: boolean;
  readonly params: Readonly<PriceParamsRecord>;
  readonly categoryName?: string;
}

export interface MachineLayout {
  readonly rows: number;
  readonly columns: number;
  readonly categories: number;
  readonly selfService: string;
  readonly products: readonly ProductSlot[];
  readonly signatureHash: string;
  readonly layoutKey: string;
  readonly ignoreRecipeMatch?: boolean;
}

export interface PriceListProductEntry extends Partial<Record<PriceParamCode, number>> {
  id: number;
  product: number;
}

export interface PriceListJson {
  rows: number;
  columns: number;
  categories: number;
  ignoreRecipeMatch: number;
  products: PriceListProductEntry[];
}

export interface MismatchedSlotInfo {
  readonly id: number;
  readonly expectedProduct: number | null;
  readonly expectedName: string;
  readonly incomingProduct: number;
}

export interface FirmwareValidationResult {
  readonly valid: boolean;
  readonly check1GridMatch: boolean;
  readonly check2RecipeMatch: boolean;
  readonly ignoreRecipeMatch: boolean;
  readonly mismatchedSlots: readonly MismatchedSlotInfo[];
  readonly abortReason: string | null;
}

export interface PartialBackupZipPackage {
  readonly fileName: string;
  readonly jsonContent: string;
  readonly zipBytes: Uint8Array;
  readonly byteLength: number;
}

export interface ApplyBackupRpcCommand {
  readonly method: MachineRpcMethod.ApplyBackup;
  readonly params: {
    readonly customer: string;
    readonly sourceFile: string;
    readonly type: FtpResourceType.Backup;
  };
}

export interface DecodedCmdStackToken {
  readonly index: number;
  readonly rawToken: string;
  readonly decodedJson: string | null;
  readonly command: ApplyBackupRpcCommand | Record<string, unknown> | null;
  readonly valid: boolean;
  readonly error?: string;
}

export interface UserProfile {
  id?: { id: string; entityType?: string };
  tenantId?: { id: string; entityType?: string };
  customerId?: { id: string; entityType?: string };
  customerTitle?: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  authority?: 'SYS_ADMIN' | 'TENANT_ADMIN' | 'CUSTOMER_USER' | string;
}

export interface CustomerOption {
  id: string;
  entityType?: EntityType;
  name: string;
  rawName: string;
  parentCustomerId: string | null;
}

export interface DeviceGroup {
  id: { id: string; entityType?: string };
  name: string;
}

export interface FleetMachine {
  id: string;
  deviceToken: string;
  customerId: string;
  customerName?: string;
  serialNumber: string;
  name: string;
  machineModel: string;
  machineType: string;
  modelTypeDisplay: string;
  location: string;
  currencySymbol: string;
  cmConnected: boolean;
  lastConnectMs?: number;
  isConfiguredIdentity: boolean;
  rawConfigJson: RawMachineConfigJson | null;
  rawProductLibraryJson: RawProductLibraryJson | null;
  layout: MachineLayout | null;
  configLoaded: boolean;
  configHash?: string | null;
  configSource?: 'ftp' | 'sample' | 'imported' | 'unavailable';
  unavailableReason?: 'offline_no_ftp_data' | 'no_ftp_data';
}

export interface LayoutCluster {
  readonly layoutKey: string;
  readonly signatureHash: string;
  readonly rows: number;
  readonly columns: number;
  readonly categories: number;
  readonly zipFileName: string;
  readonly referenceLayout: MachineLayout;
  readonly machines: readonly FleetMachine[];
}

export interface ClusterMachineValidation {
  machine: FleetMachine;
  validation: FirmwareValidationResult;
}

export interface PricingDeploymentPackage {
  priceListJson: PriceListJson;
  zipPackage: PartialBackupZipPackage;
  safeFileName: string;
}

export interface PricingDeploymentSummary {
  safeFileName: string;
  priceListJson: PriceListJson;
  zipPackage: PartialBackupZipPackage;
  onlineDispatched: number;
  offlineQueued: number;
  machineStatesById: Record<string, MachineSyncState>;
  syncStatesById: Record<string, MachineSyncState>;
  cmdStacksById: Record<string, string>;
  updatedMachinesById: Map<string, FleetMachine>;
  trackedBatch: TrackedDeploymentBatch;
}

export interface QueuedMachineSyncItem {
  readonly machineId: string;
  readonly machineLabel: string;
  readonly serialNumber: string;
  readonly customerId: string;
  readonly zipFileName: string;
  readonly queuedAtIso: string;
  readonly deliveryMode: 'online_rpc' | 'offline_cmdstack';
  readonly cmConnected: boolean;
  readonly hasPendingCmdStack: boolean;
  readonly syncedAtIso: string | null;
  readonly lastRpcAttemptAtIso?: string | null;
  readonly rpcAckedLive?: boolean;
  readonly rpcAckedAtIso?: string | null;
  readonly confirmedByConfigJson?: boolean;
  readonly preDeployConfigHash?: string | null;
  readonly preDeployAlreadyMatchedTarget?: boolean;
}

export interface TrackedDeploymentBatch {
  readonly batchId: string;
  readonly customerId: string;
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly zipFileName: string;
  readonly createdAtIso: string;
  readonly machines: readonly QueuedMachineSyncItem[];
  readonly targetLayout?: MachineLayout | null;
  readonly baselineLayoutsByMachineId?: Readonly<Record<string, MachineLayout>>;
  readonly allMachinesSyncedAtIso: string | null;
  readonly backupCleanupStatus: BackupCleanupStatus;
  readonly backupDeletedAtIso: string | null;
}

export interface ScheduledPricingJob {
  readonly id: string;
  readonly name: string;
  readonly customerId: string;
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly signatureHash: string;
  readonly zipFileName: string;
  readonly machineIds: readonly string[];
  readonly targetLayout: MachineLayout;
  readonly revertLayout: MachineLayout | null;
  readonly ignoreRecipeMatch: boolean;
  readonly recurrence: ScheduleRecurrence;
  readonly startAtIso: string;
  readonly endAtIso: string | null;
  readonly startTimeHm: string;
  readonly endTimeHm: string | null;
  readonly status: PriceScheduleStatus;
  readonly createdAtIso: string;
  readonly lastTriggeredWindowKey: string | null;
  readonly lastRevertedWindowKey: string | null;
  readonly lastTriggeredAtIso: string | null;
  readonly lastRevertedAtIso: string | null;
  readonly lastResultSummary: string | null;
}

interface DynamicPricingRuleBase {
  readonly id?: PricingPresetId | string;
  readonly targetPriceLists?: readonly PriceListGroup[];
  readonly targetBeverageFilter?: BeverageFilter;
  readonly roundStep?: number;
}

export type DynamicPricingRule =
  | (DynamicPricingRuleBase & {
      readonly mode: PricingRuleMode.PercentChange;
      readonly percentChange: number;
    })
  | (DynamicPricingRuleBase & {
      readonly mode: PricingRuleMode.FlatOffset;
      readonly flatOffsetMinor: number;
    })
  | (DynamicPricingRuleBase & {
      readonly mode: PricingRuleMode.TierPriceList2And3;
      readonly pl2Ratio: number;
      readonly pl3Ratio: number;
    })
  | (DynamicPricingRuleBase & {
      readonly mode: PricingRuleMode.FreeVend;
    });

export interface SlotParamChange {
  paramId: PriceParamCode;
  enumName: string;
  group: PriceListGroup;
  variant: string;
  before: number;
  after: number;
}

export interface ChangedSlotSummary {
  id: number;
  name: string;
  product: number;
  changes: SlotParamChange[];
}

export interface PricingDiffSummary {
  readonly changedSlotCount: number;
  readonly totalChangedFields: number;
  readonly changedSlots: readonly ChangedSlotSummary[];
}
