import { useCallback, useEffect, useState } from 'react';
import { patchApi } from '../../lib/patch';
import type { Product, ProjectEnv, WorkDirectory } from '../../lib/types';

export function useProducts(includeDeleted = false) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProducts(await patchApi.products(includeDeleted));
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [includeDeleted]);
  useEffect(() => {
    void load();
  }, [load]);
  return { products, loading, reload: load };
}

export function useProjectEnvs() {
  const [envs, setEnvs] = useState<ProjectEnv[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEnvs(await patchApi.projectEnvs());
    } catch {
      setEnvs([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { envs, loading, reload: load };
}

export function useDirectories() {
  const [directories, setDirectories] = useState<WorkDirectory[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDirectories(await patchApi.directories());
    } catch {
      setDirectories([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { directories, loading, reload: load };
}
