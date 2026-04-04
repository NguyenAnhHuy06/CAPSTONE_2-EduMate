import { useState } from 'react';
import { Upload, FileText, CheckCircle } from 'lucide-react';

interface UploadDocumentProps {
  userRole: 'instructor' | 'student';
  onUploadComplete: () => void;
}

export function UploadDocument({ userRole, onUploadComplete }: UploadDocumentProps) {
  const [formData, setFormData] = useState({
    type: 'general',
    courseCode: '',
    courseName: '',
    topicTitle: '',
    description: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setUploading(true);

    // Mock upload process
    setTimeout(() => {
      setUploading(false);
      setUploadSuccess(true);

      // Reset form after 2 seconds and redirect
      setTimeout(() => {
        setUploadSuccess(false);
        setFormData({
          type: 'general',
          courseCode: '',
          courseName: '',
          topicTitle: '',
          description: '',
        });
        setFile(null);
        onUploadComplete();
      }, 2000);
    }, 1500);
  };

  if (uploadSuccess) {
    return (
      <div className="flex items-center justify-center min-h-[600px]">
        <div className="text-center">
          <div className="bg-green-100 text-green-600 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle size={48} />
          </div>
          <h2 className="text-green-600 mb-2">Upload Successful!</h2>
          <p className="text-gray-600">Your document has been uploaded and is now available to everyone.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="mb-8 text-2xl font-semibold">Upload Course Material</h2>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6">
        {/* File Upload */}
        <div className="mb-6">
          <label className="block text-gray-700 mb-2">
            Document File *
          </label>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-600 transition-colors">
            <input
              type="file"
              onChange={handleFileChange}
              className="hidden"
              id="file-upload"
              accept=".pdf,.doc,.docx,.ppt,.pptx"
              required
            />
            <label htmlFor="file-upload" className="cursor-pointer">
              <Upload className="mx-auto mb-4 text-gray-400" size={48} />
              {file ? (
                <div>
                  <p className="text-blue-600 mb-1">{file.name}</p>
                  <p className="text-gray-500">Click to change file</p>
                </div>
              ) : (
                <div>
                  <p className="text-gray-700 mb-1">Click to upload or drag and drop</p>
                  <p className="text-gray-500">PDF, DOC, DOCX, PPT, PPTX (max 50MB)</p>
                </div>
              )}
            </label>
          </div>
        </div>

        {/* Type */}
        <div className="mb-4">
          <label className="block text-gray-700 mb-2">
            Document Type *
          </label>
          <select
            name="type"
            aria-label="Select Document Type"
            value={formData.type}
            onChange={handleInputChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          >
            <option value="general">General</option>
            <option value="general-major">General Major</option>
            <option value="specialized">Specialized</option>
          </select>
        </div>

        {/* Course Code */}
        <div className="mb-4">
          <label className="block text-gray-700 mb-2">
            Course Code *
          </label>
          <input
            type="text"
            name="courseCode"
            value={formData.courseCode}
            onChange={handleInputChange}
            placeholder="e.g., CS101, MATH201"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          />
        </div>

        {/* Course Name */}
        <div className="mb-4">
          <label className="block text-gray-700 mb-2">
            Course Name *
          </label>
          <input
            type="text"
            name="courseName"
            value={formData.courseName}
            onChange={handleInputChange}
            placeholder="e.g., Introduction to Computer Science"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          />
        </div>

        {/* Topic Title */}
        <div className="mb-4">
          <label className="block text-gray-700 mb-2">
            Topic Title *
          </label>
          <input
            type="text"
            name="topicTitle"
            value={formData.topicTitle}
            onChange={handleInputChange}
            placeholder="e.g., Data Structures Overview"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          />
        </div>

        {/* Description */}
        <div className="mb-6">
          <label className="block text-gray-700 mb-2">
            Description *
          </label>
          <textarea
            name="description"
            value={formData.description}
            onChange={handleInputChange}
            placeholder="Provide a brief description of the document content..."
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            required
          />
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={uploading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {uploading ? (
            <>
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
              Uploading...
            </>
          ) : (
            <>
              <FileText size={20} />
              Upload Document
            </>
          )}
        </button>
      </form>
    </div>
  );
}
