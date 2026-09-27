import { apiOpts } from "./core/api.js";
/**
 * Label Manager for Gmail MCP Server
 * Provides comprehensive label management functionality
 */

// Type definitions for Gmail API labels
export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  color?: {
    textColor?: string;
    backgroundColor?: string;
  };
}

/**
 * Creates a new Gmail label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The newly created label
 */
export async function createLabel(
  gmail: any,
  labelName: string,
  options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
  } = {},
  signal?: AbortSignal,
) {
  try {
    // Default visibility settings if not provided
    const messageListVisibility = options.messageListVisibility || "show";
    const labelListVisibility = options.labelListVisibility || "labelShow";

    const response = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        messageListVisibility,
        labelListVisibility,
      },
    }, apiOpts({ signal }));

    return response.data;
  } catch (error: any) {
    // Handle duplicate labels more gracefully
    if (error.message?.includes("already exists")) {
      throw new Error(`Label "${labelName}" already exists. Please use a different name.`, { cause: error });
    }

    throw new Error(`Failed to create label: ${error.message}`, { cause: error });
  }
}

/**
 * Updates an existing Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to update
 * @param updates - Properties to update
 * @returns The updated label
 */
export async function updateLabel(
  gmail: any,
  labelId: string,
  updates: {
    name?: string;
    messageListVisibility?: string;
    labelListVisibility?: string;
  },
  signal?: AbortSignal,
) {
  try {
    // Verify the label exists before updating
    await gmail.users.labels.get({
      userId: "me",
      id: labelId,
    }, apiOpts({ signal }));

    const response = await gmail.users.labels.update({
      userId: "me",
      id: labelId,
      requestBody: updates,
    }, apiOpts({ signal }));

    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new Error(`Label with ID "${labelId}" not found.`, { cause: error });
    }

    throw new Error(`Failed to update label: ${error.message}`, { cause: error });
  }
}

/**
 * Deletes a Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to delete
 * @returns Success message
 */
export async function deleteLabel(gmail: any, labelId: string, signal?: AbortSignal) {
  try {
    // Ensure we're not trying to delete system labels
    const label = await gmail.users.labels.get({
      userId: "me",
      id: labelId,
    }, apiOpts({ signal }));

    if (label.data.type === "system") {
      throw new Error(`Cannot delete system label with ID "${labelId}".`);
    }

    await gmail.users.labels.delete({
      userId: "me",
      id: labelId,
    }, apiOpts({ signal }));

    return { success: true, message: `Label "${label.data.name}" deleted successfully.` };
  } catch (error: any) {
    if (error.code === 404) {
      throw new Error(`Label with ID "${labelId}" not found.`, { cause: error });
    }

    throw new Error(`Failed to delete label: ${error.message}`, { cause: error });
  }
}

/**
 * Gets a detailed list of all Gmail labels
 * @param gmail - Gmail API instance
 * @returns Object containing system and user labels
 */
export async function listLabels(gmail: any, signal?: AbortSignal) {
  try {
    const response = await gmail.users.labels.list({
      userId: "me",
    }, apiOpts({ signal }));

    const labels = response.data.labels || [];

    // Group labels by type for better organization
    const systemLabels = labels.filter((label: GmailLabel) => label.type === "system");
    const userLabels = labels.filter((label: GmailLabel) => label.type === "user");

    return {
      all: labels,
      system: systemLabels,
      user: userLabels,
      count: {
        total: labels.length,
        system: systemLabels.length,
        user: userLabels.length,
      },
    };
  } catch (error: any) {
    throw new Error(`Failed to list labels: ${error.message}`, { cause: error });
  }
}

/**
 * Finds a label by name
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to find
 * @returns The found label or null if not found
 */
export async function findLabelByName(gmail: any, labelName: string, signal?: AbortSignal) {
  try {
    const labelsResponse = await listLabels(gmail, signal);
    const allLabels = labelsResponse.all;

    // Case-insensitive match
    const foundLabel = allLabels.find(
      (label: GmailLabel) => label.name.toLowerCase() === labelName.toLowerCase(),
    );

    return foundLabel || null;
  } catch (error: any) {
    throw new Error(`Failed to find label: ${error.message}`, { cause: error });
  }
}

/**
 * Creates label if it doesn't exist or returns existing label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The new or existing label
 */
export async function getOrCreateLabel(
  gmail: any,
  labelName: string,
  options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
  } = {},
  signal?: AbortSignal,
) {
  try {
    // First try to find an existing label
    const existingLabel = await findLabelByName(gmail, labelName, signal);

    if (existingLabel) {
      return existingLabel;
    }

    // If not found, create a new one
    return await createLabel(gmail, labelName, options, signal);
  } catch (error: any) {
    throw new Error(`Failed to get or create label: ${error.message}`, { cause: error });
  }
}
