-- Which provider serves a model choice (src/model/providers.ts): the model alone does not say, since the
-- same model can be reached directly and through a gateway. NULL is a row written before providers
-- existed, and means the deployment's default provider (DEFAULT_PROVIDER, deepseek) — which is what
-- served every such row — so adding the column changes no existing choice.
ALTER TABLE model_overrides ADD COLUMN provider TEXT;
