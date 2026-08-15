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

/** How the console searches the catalog when picking a route target or a playground model. */
export interface CatalogQuery {
  /** Restrict to one provider. Omitted ⇒ every provider, which is what the playground wants. */
  provider?: string;
  /** Case-insensitive substring match on the model id. */
  search?: string;
  /** Hard cap, so a 400-model catalog cannot become a 400-row dropdown. */
  limit: number;
}

/** A catalog entry as the console renders it. */
export interface CatalogModel {
  object: 'catalog.model';
  provider: string;
  model: string;
  capabilities: Record<string, unknown>;
}

/** Data-access boundary. The ONLY layer that touches the database. */
export interface ModelsRepository {
  list(): Promise<ModelCatalogRow[]>;
  getById(model: string): Promise<ModelCatalogRow | null>;
  search(query: CatalogQuery): Promise<ModelCatalogRow[]>;
  /** How many models each provider has — drives the "catalog looks empty" hint in the console. */
  countByProvider(): Promise<{ provider: string; count: number }[]>;
}

/** Business boundary. Maps persistence rows to API objects. No SQL, no HTTP. */
export interface ModelsService {
  listModels(): Promise<OpenAiModel[]>;
  getModel(model: string): Promise<OpenAiModel | null>;
  searchCatalog(query: CatalogQuery): Promise<CatalogModel[]>;
  catalogCounts(): Promise<Record<string, number>>;
}
