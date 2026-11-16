import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import { Button, Checkbox, Input } from '../ui';
import { useToast } from '../ui/toast';

interface MenuItem {
  key: string;
  name: string;
  visible: boolean;
}

interface UserItem {
  key: string;
  name: string;
  role_visible: boolean;
  override: boolean | null;
  visible: boolean;
}

export function MenusTab() {
  const toast = useToast();
  const [roleItems, setRoleItems] = useState<MenuItem[]>([]);
  const [roleVisible, setRoleVisible] = useState<Record<string, boolean>>({});
  const [users, setUsers] = useState<Array<{ id: number | string; username: string; display_name?: string }>>([]);
  const [keyword, setKeyword] = useState('');
  const [userId, setUserId] = useState<string>('');
  const [userItems, setUserItems] = useState<UserItem[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean | null>>({});
  const [saving, setSaving] = useState(false);

  const loadConfig = async () => {
    try {
      const result = await patchApi.menuConfig();
      setRoleItems(result.items || []);
      setRoleVisible(
        Object.fromEntries((result.items || []).map((item) => [item.key, item.visible]))
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载菜单配置失败');
    }
  };

  useEffect(() => {
    void loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searchUsers = async () => {
    try {
      const result = await patchApi.menuUsers(keyword);
      setUsers(result.items || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '搜索用户失败');
    }
  };

  const selectUser = async (id: string) => {
    setUserId(id);
    if (!id) {
      setUserItems([]);
      setOverrides({});
      return;
    }
    try {
      const result = await patchApi.menuUser(id);
      setUserItems(result.items || []);
      setOverrides(
        Object.fromEntries((result.items || []).map((item) => [item.key, item.override]))
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载用户菜单失败');
    }
  };

  const saveRole = async () => {
    setSaving(true);
    try {
      await patchApi.saveMenuConfig(roleVisible);
      toast.success('角色默认菜单已保存');
      if (userId) await selectUser(userId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveUser = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      await patchApi.saveMenuUser(userId, overrides);
      toast.success('用户菜单例外已保存');
      await selectUser(userId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[13.5px] font-semibold text-ink">角色默认可见性</div>
            <div className="mt-0.5 text-[11.5px] text-ink-3">对所有用户生效，个体例外可在右侧配置</div>
          </div>
          <Button variant="primary" size="sm" loading={saving} onClick={saveRole}>
            保存
          </Button>
        </div>
        <div className="space-y-1.5">
          {roleItems.map((item) => (
            <div key={item.key} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
              <Checkbox
                checked={roleVisible[item.key] ?? item.visible}
                onChange={(checked) => setRoleVisible((current) => ({ ...current, [item.key]: checked }))}
                label={item.name}
              />
              <span className="ml-auto font-mono text-[10.5px] text-ink-3">{item.key}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 text-[13.5px] font-semibold text-ink">用户例外</div>
        <div className="mb-2 flex gap-2">
          <div className="relative flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <Input
              className="pl-8"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void searchUsers()}
              placeholder="输入用户名搜索，回车"
            />
          </div>
          <Button onClick={searchUsers}>搜索</Button>
        </div>
        <select
          value={userId}
          onChange={(event) => void selectUser(event.target.value)}
          className="input mb-3"
        >
          <option value="">选择用户</option>
          {users.map((user) => (
            <option key={String(user.id)} value={String(user.id)}>
              {user.display_name || user.username}（{user.username}）
            </option>
          ))}
        </select>

        {userId ? (
          <>
            <div className="mb-2 space-y-1.5">
              {userItems.map((item) => (
                <div key={item.key} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{item.name}</span>
                  <span className={`badge ${item.role_visible ? 'badge-success' : 'badge-muted'}`}>
                    角色{item.role_visible ? '可见' : '隐藏'}
                  </span>
                  <select
                    value={overrides[item.key] === null || overrides[item.key] === undefined ? 'null' : String(overrides[item.key])}
                    onChange={(event) =>
                      setOverrides((current) => ({
                        ...current,
                        [item.key]:
                          event.target.value === 'null' ? null : event.target.value === 'true',
                      }))
                    }
                    className="h-7 rounded-md border border-line bg-surface-3 px-1.5 text-[11px] text-ink-2 outline-none"
                  >
                    <option value="null">跟随角色</option>
                    <option value="true">强制可见</option>
                    <option value="false">强制隐藏</option>
                  </select>
                </div>
              ))}
            </div>
            <Button variant="primary" size="sm" loading={saving} onClick={saveUser}>
              保存用户例外
            </Button>
          </>
        ) : (
          <div className="py-8 text-center text-[12px] text-ink-3">搜索并选择用户后配置例外</div>
        )}
      </div>
    </div>
  );
}
