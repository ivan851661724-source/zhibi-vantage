import { redirect } from 'next/navigation';

// Provider credentials are managed by the platform, outside the user panel.
export default function SettingsPage() {
  redirect('/');
}
