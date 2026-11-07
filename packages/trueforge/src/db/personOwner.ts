/** The person a row belongs to: their tenant and their own subject id. */
export interface PersonOwner {
  tenant_id: string;
  created_by: string;
}
