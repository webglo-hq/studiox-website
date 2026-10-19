/** Tenant-level settings stored in `tenants.settings` (JSONB). */
export interface TenantSettings {
  /** Demo tenants run on a scenario clock so the planted close is always "today". */
  businessDate?: string;
  /** Roles that must enrol and verify TOTP before using the app. */
  mfaRequiredRoles?: string[];
  sessionIdleMinutes?: number;
  sessionAbsoluteHours?: number;
  /** 'auto' = live LLM when an API key is configured, otherwise the offline engine. */
  agentMode?: 'auto' | 'offline' | 'live';
  /** The period the "My close" home focuses on. */
  activeCloseKey?: string;
  /** Display-only branding of the customer workspace. */
  displayName?: string;
}

export interface UserPreferences {
  theme?: 'light' | 'dark' | 'system';
  density?: 'comfortable' | 'compact';
  guidedTourDone?: boolean;
  defaultEntityId?: string | null;
}
