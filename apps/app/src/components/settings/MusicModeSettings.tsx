import { useRef, useState } from "react";
import {
  MUSIC_MODE_THEME_ID,
  MUSIC_PORT_MAX,
  MUSIC_PORT_MIN,
  musicPortSchema,
  musicSecretSchema,
  type AppTheme,
  type AppThemeSelection,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Switch } from "@bb/shared-ui/switch";
import { cn } from "@bb/shared-ui/lib/utils";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { useWriteMusicSecret } from "@/hooks/mutations/settings-mutations";
import type { MusicSignalStatus } from "@/lib/music/music-signal-controller";
import { useMusicSignalStatus } from "@/lib/music/music-signal-status";

export const MUSIC_MODE_SETTING_LABEL = "Music mode";
export const MUSIC_PORT_SETTING_LABEL = "Phosphene port";
export const MUSIC_SECRET_SETTING_LABEL = "Pairing secret";

export type MusicSelectionUpdate = Partial<
  Pick<AppThemeSelection, "musicMode" | "musicPort">
>;

interface MusicModeSettingsProps {
  appearance: AppTheme;
  disabled: boolean;
  onSelectionChange: (update: MusicSelectionUpdate) => void;
}

export function describeMusicSignalStatus(
  appearance: AppTheme,
  status: MusicSignalStatus,
): string {
  if (!appearance.musicMode) return "Off.";
  if (appearance.themeId !== MUSIC_MODE_THEME_ID) {
    return "On, but music mode only affects the Dorcas palette.";
  }
  if (appearance.musicSecret === null) {
    return "On, waiting for a pairing secret from Phosphene.";
  }
  switch (status.kind) {
    case "off":
      return "On.";
    case "paused":
      return "Paused while this window is hidden, or while reduced motion or forced colors are on.";
    case "connecting":
      return "Connecting to Phosphene on this Mac.";
    case "connected":
      return "Connected to Phosphene.";
    case "retrying":
      return `Not connected (${status.reason}). Retrying in ${Math.ceil(status.retryInMs / 1000)} s.`;
  }
}

function MusicPortSetting({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (port: number) => void;
  value: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const [committedValue, setCommittedValue] = useState(value);
  if (value !== committedValue) {
    setCommittedValue(value);
    setDraft(String(value));
  }
  const parsed = musicPortSchema.safeParse(Number(draft));
  const valid = /^\d+$/.test(draft) && parsed.success;
  const commit = () => {
    if (!valid) {
      setDraft(String(value));
      return;
    }
    if (parsed.data !== value) onChange(parsed.data);
  };
  return (
    <SettingsWithControl
      label={MUSIC_PORT_SETTING_LABEL}
      description={
        valid ? (
          "The loopback port Phosphene listens on. Leave it at the default unless you changed it in Phosphene."
        ) : (
          <span className="text-destructive" role="alert">
            {`Use a port from ${MUSIC_PORT_MIN} to ${MUSIC_PORT_MAX}.`}
          </span>
        )
      }
    >
      <Input
        value={draft}
        inputMode="numeric"
        aria-label={MUSIC_PORT_SETTING_LABEL}
        aria-invalid={!valid}
        disabled={disabled}
        className={cn(
          "h-8 w-28 font-mono text-xs",
          !valid && "border-destructive focus-visible:ring-destructive",
        )}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
      />
    </SettingsWithControl>
  );
}

function MusicSecretSetting({
  disabled,
  secretSet,
}: {
  disabled: boolean;
  secretSet: boolean;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { write, pending } = useWriteMusicSecret();
  const busy = disabled || pending;

  const save = async (candidate: string) => {
    const parsed = musicSecretSchema.safeParse(candidate.trim());
    if (!parsed.success) {
      setProblem("That is not a Phosphene pairing secret.");
      return;
    }
    setProblem(null);
    if (await write(parsed.data)) clearField();
  };

  const clearField = () => {
    if (field.current) field.current.value = "";
    setHasDraft(false);
  };

  const saveField = () => {
    const candidate = field.current?.value ?? "";
    if (candidate !== "") void save(candidate);
  };

  const readFile = async (file: File) => {
    let contents: string;
    try {
      contents = await file.text();
    } catch {
      setProblem("That file could not be read.");
      return;
    }
    await save(contents);
  };

  return (
    <SettingsWithControl
      label={MUSIC_SECRET_SETTING_LABEL}
      description={
        problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : secretSet ? (
          "Paired. Paste or choose a new secret to replace it."
        ) : (
          "Paste the secret Phosphene shows, or choose the file it exported."
        )
      }
      controlPlacement="below"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={MUSIC_SECRET_SETTING_LABEL}
          aria-invalid={problem !== null}
          disabled={busy}
          placeholder={secretSet ? "Stored" : "Not set"}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          onChange={(event) => {
            setHasDraft(event.target.value !== "");
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveField();
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !hasDraft}
          onClick={saveField}
        >
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          Choose file
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !secretSet}
          onClick={() => {
            setProblem(null);
            clearField();
            void write(null);
          }}
        >
          Clear
        </Button>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label="Pairing secret file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void readFile(file);
          }}
        />
      </div>
    </SettingsWithControl>
  );
}

export function MusicModeSettings({
  appearance,
  disabled,
  onSelectionChange,
}: MusicModeSettingsProps) {
  const status = useMusicSignalStatus();
  return (
    <>
      <SettingsWithControl
        label={MUSIC_MODE_SETTING_LABEL}
        description={`Dorcas tints its lines with the key and pulses a sidebar glow with the beat that Phosphene hears on this Mac. Only the Dorcas palette responds, and nothing moves under reduced motion or forced colors. ${describeMusicSignalStatus(appearance, status)}`}
      >
        <Switch
          checked={appearance.musicMode}
          disabled={disabled}
          onCheckedChange={(musicMode) => onSelectionChange({ musicMode })}
          aria-label={MUSIC_MODE_SETTING_LABEL}
        />
      </SettingsWithControl>
      {appearance.musicMode ? (
        <>
          <MusicPortSetting
            disabled={disabled}
            value={appearance.musicPort}
            onChange={(musicPort) => onSelectionChange({ musicPort })}
          />
          <MusicSecretSetting
            disabled={disabled}
            secretSet={appearance.musicSecret === "set"}
          />
        </>
      ) : null}
    </>
  );
}
