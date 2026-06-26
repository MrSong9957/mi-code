export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  description: string;
  body: string;
  slug: string;
  createdAt: string;
}

export interface MemoryIndexEntry {
  slug: string;
  name: string;
  type: MemoryType;
  description: string;
}
