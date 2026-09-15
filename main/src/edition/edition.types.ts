export type Edition = 'community' | 'professional';

export interface FeatureGates {
  maxCoWorkers: number;
  cloudModelDirect: boolean;
  modelConfigEditable: boolean;
  customRoles: boolean;
  mcpServers: boolean;
}

// Fallback features when no valid license is available
export const EDITION_FEATURES: Record<Edition, FeatureGates> = {
  community: {
    maxCoWorkers: 3,
    cloudModelDirect: false,
    modelConfigEditable: false,
    customRoles: false,
    mcpServers: false,
  },
  professional: {
    maxCoWorkers: 999,
    cloudModelDirect: true,
    modelConfigEditable: true,
    customRoles: true,
    mcpServers: true,
  },
};

export interface InstallationRecord {
  id: string;
  machineFingerprint: string;
  edition: Edition;
  companyName: string;
  contactPerson: string;
  contactPhone: string;
  installationToken: string | null;
  licenseBlob: string | null;
  creditsBalance: number;
  registeredAt: Date;
  lastSync: Date | null;
  setupPhase: 'pending' | 'registered' | 'complete';
  needsGuidedConfig: boolean;
}

export interface RegisterDto {
  companyName: string;
  contactPerson: string;
  contactPhone: string;
}

export interface VerifyDto {
  contactPhone: string;
  code: string;
}
