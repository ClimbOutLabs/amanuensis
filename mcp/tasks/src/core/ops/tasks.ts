// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Google Tasks API operations backing the MCP tools.
//
// Each op takes an authenticated OAuth2Client and returns plain JSON-safe
// objects. Errors from the API surface as-is so the MCP tool layer can wrap
// them with tool context.

import { OAuth2Client } from "google-auth-library";
import { google, tasks_v1 } from "googleapis";

export interface TaskListSummary {
  id?: string | null;
  title?: string | null;
}

export interface TaskSummary {
  id?: string | null;
  title?: string | null;
  notes?: string | null;
  status?: string | null;
  due?: string | null;
  updated?: string | null;
  parent?: string | null;
  position?: string | null;
}

function toTaskSummary(task: tasks_v1.Schema$Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    due: task.due,
    updated: task.updated,
    parent: task.parent,
    position: task.position,
  };
}

/** List the user's task lists. */
export async function listTaskLists(auth: OAuth2Client): Promise<TaskListSummary[]> {
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasklists.list({ maxResults: 100 });
  return (res.data.items ?? []).map(list => ({ id: list.id, title: list.title }));
}

export interface ListTasksArgs {
  tasklist?: string;
  showCompleted?: boolean;
  maxResults?: number;
  dueMin?: string;
  dueMax?: string;
}

/** List tasks. Defaults to the default task list, hiding completed tasks. */
export async function listTasks(auth: OAuth2Client, args: ListTasksArgs = {}): Promise<TaskSummary[]> {
  const tasks = google.tasks({ version: "v1", auth });
  const tasklist = args.tasklist ?? "@default";
  const res = await tasks.tasks.list({
    tasklist,
    showCompleted: args.showCompleted ?? false,
    showDeleted: false,
    maxResults: args.maxResults ?? 50,
    ...(args.dueMin ? { dueMin: args.dueMin } : {}),
    ...(args.dueMax ? { dueMax: args.dueMax } : {}),
  });
  return (res.data.items ?? []).map(toTaskSummary);
}

export interface CreateTaskArgs {
  tasklist?: string;
  title: string;
  notes?: string;
  due?: string;
}

/** Create a task. `due` accepts an RFC3339 date-time. */
export async function createTask(auth: OAuth2Client, args: CreateTaskArgs): Promise<TaskSummary> {
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasks.insert({
    tasklist: args.tasklist ?? "@default",
    requestBody: {
      title: args.title,
      ...(args.notes ? { notes: args.notes } : {}),
      ...(args.due ? { due: args.due } : {}),
    },
  });
  return toTaskSummary(res.data);
}

export interface CompleteTaskArgs {
  tasklist?: string;
  taskId: string;
}

/** Mark a task complete. */
export async function completeTask(
  auth: OAuth2Client,
  args: CompleteTaskArgs,
): Promise<TaskSummary> {
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasks.patch({
    tasklist: args.tasklist ?? "@default",
    task: args.taskId,
    requestBody: { status: "completed" },
  });
  return toTaskSummary(res.data);
}

export interface DeleteTaskArgs {
  tasklist?: string;
  taskId: string;
}

/** Delete a task by id. */
export async function deleteTask(
  auth: OAuth2Client,
  args: DeleteTaskArgs,
): Promise<{ deleted: true; taskId: string }> {
  const tasks = google.tasks({ version: "v1", auth });
  await tasks.tasks.delete({
    tasklist: args.tasklist ?? "@default",
    task: args.taskId,
  });
  return { deleted: true, taskId: args.taskId };
}
