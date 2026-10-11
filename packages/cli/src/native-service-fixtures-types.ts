export interface NativePostgresFixture {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: 'postgres';
  stop(): Promise<void>;
}
export interface NativeRedisFixture {
  readonly host: '127.0.0.1';
  readonly port: number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}
export interface NativeLocalstackFixture {
  readonly endpoint: string;
  readonly region: 'us-east-1';
  readonly credentials: Readonly<{ accessKeyId: 'test'; secretAccessKey: 'test' }>;
  stop(): Promise<void>;
}
export interface NativeServiceFixtures {
  postgres(): Promise<NativePostgresFixture>;
  redis(): Promise<NativeRedisFixture>;
  localstackS3(): Promise<NativeLocalstackFixture>;
  localstackS3Kms(): Promise<NativeLocalstackFixture>;
  verify(): Promise<void>;
}
