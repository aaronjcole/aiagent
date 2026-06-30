import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable, ApiSideWarning } from '../../components/ApiError';
import type { SystemSetting, Json, AutomationCounts } from '../../lib/types';
import { AutoSendToggle } from './AutoSendToggle';
import {
  SelectSetting,
  ValueSetting,
  ToggleSetting,
  ListSetting,
} from './SettingControls';
import {
  EMAIL_AUTONOMY_OPTIONS,
  CALENDAR_AUTONOMY_OPTIONS,
  EMAIL_AUTONOMY_DEFAULT,
  CALENDAR_AUTONOMY_DEFAULT,
  CAP_DEFS,
  THRESHOLD_DEFS,
  BUSINESS_HOURS_NUMERIC_DEFS,
  BUSINESS_TIMEZONE_DEF,
  KILLSWITCH_BOOLEAN_DEFS,
  KILLSWITCH_LIST_DEFS,
  READINESS_DEFS,
  GLOBAL_PAUSE_KEY,
  MANAGED_KEYS,
} from './definitions';
import {
  asBool,
  asNumber,
  asString,
  asStringArray,
  settingValue,
} from './values';

/** Always render at request time so settings reflect live API data. */
export const dynamic = 'force-dynamic';

const AUTO_SEND_KEY = 'auto_send_enabled';

/** Render a JSON setting value as a display string. */
function renderValue(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * System settings page for the controlled-autonomy phase. Sections:
 *  1. Autonomy modes (email/calendar) + legacy auto-send toggle
 *  2. Sending caps, thresholds & business hours (inline number/text edits)
 *  3. Kill switches (boolean pauses + comma-list pauses)
 *  4. Compliance readiness checklist (8 booleans)
 *  5. Live counts (global sends + calendar events today, vs caps)
 *  6. Other (unmanaged) settings, read-only table
 *
 * Reads `GET /settings` and `GET /automation/counts`; every edit PUTs to
 * `PUT /settings/:key`. Degrades gracefully when the API is unreachable or a
 * key/endpoint is missing (falls back to conservative defaults).
 */
export default async function SettingsPage() {
  const [settingsRes, countsRes] = await Promise.all([
    read<unknown>('/settings'),
    read<AutomationCounts>('/automation/counts'),
  ]);

  if (!settingsRes.ok) {
    return (
      <div>
        <h2>System settings</h2>
        <ApiUnreachable error={settingsRes.error} />
      </div>
    );
  }

  const settings = asArray<SystemSetting>(settingsRes.data) ?? [];

  // --- Section 1: autonomy modes + legacy auto-send ---
  const emailMode = asString(settingValue(settings, 'emailAutonomyMode'), EMAIL_AUTONOMY_DEFAULT);
  const calendarMode = asString(
    settingValue(settings, 'calendarAutonomyMode'),
    CALENDAR_AUTONOMY_DEFAULT,
  );
  const autoSendOn = asBool(settingValue(settings, AUTO_SEND_KEY));

  // --- Section 4: readiness ---
  const readinessAllChecked = READINESS_DEFS.every((d) =>
    asBool(settingValue(settings, d.key), d.default),
  );

  // --- Section 5: live counts vs caps ---
  const counts: AutomationCounts | null = countsRes.ok ? countsRes.data : null;
  const globalCap = asNumber(settingValue(settings, 'maxAutoSendsPerDayGlobal'), 10);
  const calendarCap = asNumber(settingValue(settings, 'maxCalendarEventsPerDay'), 10);

  // --- Section 6: other settings not managed by a dedicated control ---
  const otherSettings = settings.filter((s) => s.key !== AUTO_SEND_KEY && !MANAGED_KEYS.has(s.key));

  return (
    <div>
      <h2>System settings</h2>

      {/* 1. Autonomy modes */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Autonomy modes</h3>
        <div className="note">
          Changing a mode here flips the <code>SystemSetting</code> row only. Autonomous behavior
          ALSO requires the matching env flag to be enabled server-side; modes are an upper bound,
          never a force-on.
        </div>
        <div style={{ marginTop: 12 }}>
          <SelectSetting
            settingKey="emailAutonomyMode"
            label="Email autonomy"
            value={emailMode}
            options={EMAIL_AUTONOMY_OPTIONS}
            defaultValue={EMAIL_AUTONOMY_DEFAULT}
            note={
              <>
                <code>limited_auto_send</code> additionally requires the <code>AUTO_SEND_ENABLED</code>{' '}
                env flag AND all readiness items checked (see below).
              </>
            }
          />
          <SelectSetting
            settingKey="calendarAutonomyMode"
            label="Calendar autonomy"
            value={calendarMode}
            options={CALENDAR_AUTONOMY_OPTIONS}
            defaultValue={CALENDAR_AUTONOMY_DEFAULT}
            note={
              <>
                <code>auto_book_confirmed</code> requires the matching calendar env flag to be on.
              </>
            }
          />
        </div>

        <h4 style={{ marginBottom: 4 }}>Legacy auto-send toggle</h4>
        <div className="note">
          <strong>Auto-send ALSO requires the <code>AUTO_SEND_ENABLED</code> env flag.</strong> This
          toggle flips the <code>{AUTO_SEND_KEY}</code> setting. The send pipeline gates on BOTH the
          env flag and this setting; <code>SENDING_ENABLED</code> must also be on. Default is OFF.
        </div>
        <div style={{ marginTop: 12 }}>
          <AutoSendToggle initialValue={autoSendOn} />
        </div>
      </div>

      {/* 2. Caps, thresholds & business hours */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Sending caps & business hours</h3>
        <p className="muted">Each value is editable inline; Save PUTs to <code>/settings/:key</code>.</p>

        <h4>Caps</h4>
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {CAP_DEFS.map((d) => (
              <ValueSetting
                key={d.key}
                settingKey={d.key}
                label={d.label}
                value={String(asNumber(settingValue(settings, d.key), d.default))}
                kind={d.kind}
                unit={d.unit}
                help={d.help}
              />
            ))}
          </tbody>
        </table>

        <h4 style={{ marginTop: 16 }}>Confidence thresholds</h4>
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {THRESHOLD_DEFS.map((d) => (
              <ValueSetting
                key={d.key}
                settingKey={d.key}
                label={d.label}
                value={String(asNumber(settingValue(settings, d.key), d.default))}
                kind={d.kind}
                unit={d.unit}
                help={d.help}
              />
            ))}
          </tbody>
        </table>

        <h4 style={{ marginTop: 16 }}>Business hours</h4>
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {BUSINESS_HOURS_NUMERIC_DEFS.map((d) => (
              <ValueSetting
                key={d.key}
                settingKey={d.key}
                label={d.label}
                value={String(asNumber(settingValue(settings, d.key), d.default))}
                kind={d.kind}
                unit={d.unit}
              />
            ))}
            <ValueSetting
              settingKey={BUSINESS_TIMEZONE_DEF.key}
              label={BUSINESS_TIMEZONE_DEF.label}
              value={asString(settingValue(settings, BUSINESS_TIMEZONE_DEF.key), BUSINESS_TIMEZONE_DEF.default)}
              kind="text"
            />
          </tbody>
        </table>
      </div>

      {/* 3. Kill switches */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Kill switches</h3>
        {KILLSWITCH_BOOLEAN_DEFS.map((d) => (
          <ToggleSetting
            key={d.key}
            settingKey={d.key}
            label={d.label}
            value={asBool(settingValue(settings, d.key), d.default)}
            help={d.help}
            prominent={d.key === GLOBAL_PAUSE_KEY}
          />
        ))}
        <div style={{ marginTop: 16 }}>
          {KILLSWITCH_LIST_DEFS.map((d) => (
            <ListSetting
              key={d.key}
              settingKey={d.key}
              label={d.label}
              value={asStringArray(settingValue(settings, d.key))}
              placeholder={d.placeholder}
            />
          ))}
        </div>
      </div>

      {/* 4. Compliance readiness checklist */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Compliance readiness checklist</h3>
        <div className={readinessAllChecked ? 'msg ok' : 'note'}>
          <strong>LIMITED_AUTO_SEND requires ALL readiness items checked.</strong>{' '}
          {readinessAllChecked
            ? 'All items are confirmed.'
            : 'Some items are not yet confirmed — limited auto-send will remain gated.'}
        </div>
        <div style={{ marginTop: 12 }}>
          {READINESS_DEFS.map((d) => (
            <ToggleSetting
              key={d.key}
              settingKey={d.key}
              label={d.label}
              value={asBool(settingValue(settings, d.key), d.default)}
            />
          ))}
        </div>
      </div>

      {/* 5. Live counts */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Live counts (today)</h3>
        {!countsRes.ok ? (
          <ApiSideWarning label="automation counts" error={countsRes.error} />
        ) : null}
        <div className="cards">
          <div className="card">
            <div className="num">
              {counts?.globalSentToday ?? '—'} <span className="muted" style={{ fontSize: 16 }}>/ {globalCap}</span>
            </div>
            <div className="label">Global sends today</div>
          </div>
          <div className="card">
            <div className="num">
              {counts?.calendarEventsToday ?? '—'} <span className="muted" style={{ fontSize: 16 }}>/ {calendarCap}</span>
            </div>
            <div className="label">Calendar events today</div>
          </div>
        </div>
      </div>

      {/* 6. Other (unmanaged) settings */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Other settings</h3>
        {otherSettings.length === 0 ? (
          <p className="muted">No additional settings returned by the API.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Description</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {otherSettings.map((s) => (
                <tr key={s.key}>
                  <td>
                    <code>{s.key}</code>
                  </td>
                  <td>{renderValue(s.value)}</td>
                  <td>{s.description ?? '—'}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
