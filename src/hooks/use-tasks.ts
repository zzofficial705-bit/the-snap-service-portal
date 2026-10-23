'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { TaskItem, TaskCategory, TaskPriority, TaskHistoryEntry } from '@/lib/types';
import { storage } from '@/lib/storage';
import { generateSecureId } from '@/lib/crypto';
import { apiFetchTasks, apiSaveTask, apiDeleteTask } from '@/lib/api-client';
import { useAuth } from './use-auth';

// Seed sample tasks if studio tasks are completely empty
const INITIAL_SEED_TASKS: TaskItem[] = [
  {
    id: 'task-seed-1',
    title: 'Follow up with Photographer for upcoming event',
    category: 'events',
    subCategory: 'Follow up with photographer/videographer',
    quotationNumber: 'SS-2026-001',
    clientName: 'Sarah & Bilal',
    assignedToName: 'Zunair Ahmad (Owner)',
    assignedToUserId: 'user-super-admin',
    startDateTime: new Date(Date.now() - 30 * 60000).toISOString().slice(0, 16),
    deadlineDateTime: new Date(Date.now() + 60 * 60000).toISOString().slice(0, 16),
    priority: 'high',
    notes: 'Verify Sony A7IV lens setup and flash triggers.',
    history: [
      {
        id: 'hist-1',
        timestamp: new Date().toISOString(),
        userId: 'user-super-admin',
        userName: 'Zunair Ahmad (Owner)',
        action: 'Task created',
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'task-seed-2',
    title: 'Send album for designing to design team',
    category: 'albums',
    subCategory: 'Send album for designing',
    assignedToName: 'Staff Photographer',
    assignedToUserId: 'user-staff-1',
    startDateTime: new Date(Date.now() + 120 * 60000).toISOString().slice(0, 16),
    deadlineDateTime: new Date(Date.now() + 360 * 60000).toISOString().slice(0, 16),
    priority: 'medium',
    notes: 'High-res couple portraits shortlisted by client.',
    history: [
      {
        id: 'hist-2',
        timestamp: new Date().toISOString(),
        userId: 'user-super-admin',
        userName: 'Zunair Ahmad (Owner)',
        action: 'Task created',
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

export function useTasks() {
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === 'super_admin' || currentUser?.id === 'user-super-admin';
  const currentUserId = currentUser?.id || 'user-super-admin';
  const targetWs = isSuperAdmin
    ? 'ws_user-super-admin'
    : (currentUser?.workspaceId || `ws_${currentUserId}`);

  const isTaskAccessible = useCallback(
    (t: TaskItem): boolean => {
      if (isSuperAdmin) return true;
      const cleanWs = targetWs.startsWith('ws_') ? targetWs : `ws_${targetWs}`;
      return (
        t.workspaceId === cleanWs ||
        t.assignedToUserId === currentUserId ||
        (t.assignedToUserId ? (t.assignedToUserId.startsWith('ws_') ? t.assignedToUserId === cleanWs : `ws_${t.assignedToUserId}` === cleanWs) : false) ||
        t.createdByUserId === currentUserId ||
        (Array.isArray(t.history) && t.history.some((h) => h.userId === currentUserId))
      );
    },
    [isSuperAdmin, targetWs, currentUserId]
  );

  const isInitialMount = useRef(true);
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<TaskItem[]>(() => {
    const local = storage.getTasks();
    if (local.length > 0) {
      return local.filter(isTaskAccessible);
    }
    return [];
  });

  const syncTasks = useCallback(async (isSilent = false) => {
    try {
      if (!isSilent && isInitialMount.current) {
        setLoading(true);
      }
      const cloudTasks = await apiFetchTasks(targetWs);
      if (Array.isArray(cloudTasks)) {
        storage.setAllTasks(cloudTasks);
        const filtered = cloudTasks.filter(isTaskAccessible);
        setTasks(filtered);
      }
    } catch (e) {
      console.error('Error syncing tasks with cloud:', e);
      const local = storage.getTasks();
      if (local.length > 0) {
        setTasks(local.filter(isTaskAccessible));
      }
    } finally {
      isInitialMount.current = false;
      setLoading(false);
    }
  }, [targetWs, isTaskAccessible]);

  useEffect(() => {
    syncTasks(false);

    // Safe visibility-aware sync: Only refresh when tab is visible
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        syncTasks(true);
      }
    }, 30000);

    const handleStorage = () => {
      const all = storage.getTasks();
      const filtered = all.filter(isTaskAccessible);
      setTasks(filtered);
    };

    const handleUserSwitch = () => {
      syncTasks(true);
    };

    const handleFocus = () => syncTasks(true);

    window.addEventListener('snap_tasks_updated', handleStorage);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('snap_user_switched', handleUserSwitch);
    window.addEventListener('focus', handleFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('snap_tasks_updated', handleStorage);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('snap_user_switched', handleUserSwitch);
      window.removeEventListener('focus', handleFocus);
    };
  }, [syncTasks, isTaskAccessible]);

  const createTask = async (payload: Omit<TaskItem, 'id' | 'createdAt' | 'updatedAt' | 'history'>): Promise<TaskItem> => {
    const taskId = generateSecureId('task');
    const now = new Date().toISOString();
    const ws = currentUser?.role === 'super_admin' || currentUser?.id === 'user-super-admin'
      ? 'ws_user-super-admin'
      : (currentUser?.workspaceId || `ws_${currentUser?.id || 'user-super-admin'}`);

    const historyEntry: TaskHistoryEntry = {
      id: generateSecureId('hist'),
      timestamp: now,
      userId: currentUser?.id || 'user-super-admin',
      userName: currentUser?.name || 'Studio Admin',
      action: 'Task created',
      details: `Created with priority ${payload.priority.toUpperCase()}`,
    };

    const newTask: TaskItem = {
      ...payload,
      id: taskId,
      workspaceId: ws,
      createdByUserId: currentUser?.id || 'user-super-admin',
      updatedByUserId: currentUser?.id || 'user-super-admin',
      history: [historyEntry],
      createdAt: now,
      updatedAt: now,
    };

    storage.saveTask(newTask);
    setTasks((prev) => [newTask, ...prev]);

    try {
      await apiSaveTask(newTask);
    } catch (e) {
      console.error('Error saving task to cloud:', e);
    }

    return newTask;
  };

  const updateTask = async (task: TaskItem, changeActionDesc?: string): Promise<TaskItem> => {
    const now = new Date().toISOString();
    const historyEntry: TaskHistoryEntry = {
      id: generateSecureId('hist'),
      timestamp: now,
      userId: currentUser?.id || 'user-super-admin',
      userName: currentUser?.name || 'Studio Admin',
      action: changeActionDesc || 'Task updated',
    };

    const updated: TaskItem = {
      ...task,
      history: [historyEntry, ...(task.history || [])],
      updatedAt: now,
    };

    storage.saveTask(updated);
    setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));

    try {
      await apiSaveTask(updated);
    } catch (e) {
      console.error('Error updating task in cloud:', e);
    }

    return updated;
  };

  const toggleTaskComplete = async (taskId: string): Promise<TaskItem | null> => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return null;

    const isNowCompleted = task.manualStatus !== 'completed';
    const nextManualStatus = isNowCompleted ? 'completed' : 'in_progress';
    const actionDesc = isNowCompleted ? 'Marked task as COMPLETED' : 'Reopened task';

    const res = await updateTask(
      {
        ...task,
        manualStatus: nextManualStatus,
      },
      actionDesc
    );

    // Notify Super Admin and Assignee about task completion / reopening
    try {
      const actorName = currentUser?.name || 'Studio Member';
      const targets = Array.from(new Set([task.assignedToUserId, 'user-super-admin'])).filter(Boolean);
      for (const uid of targets) {
        fetch('/api/notifications/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: uid,
            userName: actorName,
            title: isNowCompleted ? `✅ Completed: ${task.title}` : `Reopened: ${task.title}`,
            body: `${isNowCompleted ? 'Completed' : 'Reopened'} by ${actorName}`,
            url: '/tasks',
            type: 'status_update',
          }),
        }).catch(() => {});
      }
    } catch {}

    return res;
  };

  const setTaskWaiting = async (taskId: string, followUpDateTime?: string, reasonNotes?: string): Promise<TaskItem | null> => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return null;

    const updatedTask: TaskItem = {
      ...task,
      manualStatus: 'waiting',
      followUpDateTime: followUpDateTime || task.followUpDateTime,
      notes: reasonNotes ? `${task.notes ? task.notes + '\n\n' : ''}[Waiting Note]: ${reasonNotes}` : task.notes,
    };

    const res = await updateTask(
      updatedTask,
      `Status changed to WAITING (Follow-up scheduled for ${followUpDateTime || 'TBD'})`
    );

    // Notify Super Admin and Assignee about waiting follow-up
    try {
      const actorName = currentUser?.name || 'Studio Member';
      const targets = Array.from(new Set([task.assignedToUserId, 'user-super-admin'])).filter(Boolean);
      for (const uid of targets) {
        fetch('/api/notifications/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: uid,
            userName: actorName,
            title: `⏳ Waiting: ${task.title}`,
            body: `Waiting follow-up set by ${actorName}${reasonNotes ? ` • ${reasonNotes}` : ''}`,
            url: '/tasks',
            type: 'follow_up',
          }),
        }).catch(() => {});
      }
    } catch {}

    return res;
  };

  const deleteTask = async (taskId: string): Promise<boolean> => {
    storage.deleteTask(taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));

    try {
      await apiDeleteTask(taskId);
    } catch (e) {
      console.error('Error deleting task from cloud:', e);
    }

    return true;
  };

  return {
    tasks,
    loading,
    createTask,
    updateTask,
    toggleTaskComplete,
    setTaskWaiting,
    deleteTask,
    refreshTasks: syncTasks,
  };
}
