export interface DbQueryClient {
  query: (...args: never[]) => unknown;
}

function queryCapability<TClient extends DbQueryClient>(client: TClient) {
  return Object.freeze({
    query: client.query.bind(client) as OmitThisParameter<TClient['query']>,
  });
}

export function createDbCapabilities<TClient extends DbQueryClient>(
  client: TClient,
): Readonly<{
  read: Readonly<{ query: OmitThisParameter<TClient['query']> }>;
  write: Readonly<{ query: OmitThisParameter<TClient['query']> }>;
}> {
  return Object.freeze({
    read: queryCapability(client),
    write: queryCapability(client),
  });
}
