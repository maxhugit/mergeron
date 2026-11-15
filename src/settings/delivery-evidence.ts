export const deliveryEvidenceReasons = [
  'registry_receipt_required',
  'runtime_receipt_required',
  'administrator_required',
  'registry_unavailable',
  'commit_mismatch',
  'manager_unavailable',
  'runtime_not_healthy',
  'different_commit',
  'image_identity_mismatch',
  'verified_registry',
  'verified_manager',
] as const;
export interface DeliveryEvidence {
  state: 'verified' | 'unverified';
  reason: (typeof deliveryEvidenceReasons)[number];
  checkedAt?: number;
  revision?: string;
  reference?: string;
  imageId?: string;
  observedRevision?: string | null;
  environment?: 'development' | 'production' | 'unknown';
}
