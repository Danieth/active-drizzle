/**
 * Global test setup for @active-drizzle/controller tests.
 *
 * Mocks optional peer dependencies that aren't installed in the dev environment:
 * - @aws-sdk/client-s3 (optional peer of @active-drizzle/core storage module)
 * - @aws-sdk/s3-request-presigner
 */
import { vi } from 'vitest'

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
  GetObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
  HeadObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
  DeleteObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/bucket/key?signed=1'),
}))
