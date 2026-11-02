import { redirect } from 'next/navigation';

/** Minutes now live on the dashboard; old links land there. */
export default function UsagePage() {
  redirect('/dashboard');
}
