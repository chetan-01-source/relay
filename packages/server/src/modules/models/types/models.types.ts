/**
 * Models module interfaces (OpenAI-compatible GET /v1/models). Reference vertical showing the
 * full layered stack routes → controller → service → repository → queries against a real table
 * (the global model_catalog). Every layer depends on an interface declared here.
 */

/** A row as it exists in the model_catalog table (persistence shape). */
export interface ModelCatalogRow {
  provider: string;
  model: string;
  capabilities: Record<string, unknown>;
}

/** OpenAI /v1/models object (API shape returned to clients). */
export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/** Data-access boundary. The ONLY layer that touches the database. */
export interface ModelsRepository {
  list(): Promise<ModelCatalogRow[]>;
  getById(model: string): Promise<ModelCatalogRow | null>;
}

/** Business boundary. Maps persistence rows to API objects. No SQL, no HTTP. */
export interface ModelsService {
  listModels(): Promise<OpenAiModel[]>;
  getModel(model: string): Promise<OpenAiModel | null>;
}
