import { format } from "date-fns"

export function formatDate(dateString: string) {
  try {
    return format(new Date(dateString), "MMM d, yyyy")
  } catch (e) {
    return dateString
  }
}

export function formatDateTime(dateString: string) {
  try {
    return format(new Date(dateString), "MMM d, yyyy h:mm a")
  } catch (e) {
    return dateString
  }
}

export function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}
